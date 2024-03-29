/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, exists, realpath } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import * as which from 'which';
import { EventEmitter } from 'events';
import * as iconv from 'iconv-lite';
import * as filetype from 'file-type';
import { assign, groupBy, IDisposable, toDisposable, dispose, mkdirp, readBytes, detectUnicodeEncoding, Encoding, onceEvent, splitInChunks, Limiter } from './util';
import { CancellationToken, Progress, Uri, TextEditorLineNumbersStyle } from 'vscode';
import { URI } from 'vscode-uri';
import { detectEncoding } from './encoding';
import { Ref, RefType, Branch, Remote, VsrErrorCodes, LogOptions, Change, Status, CommitOptions, BranchQuery } from './api/vsr';
import * as byline from 'byline';
import { StringDecoder } from 'string_decoder';
import { listenerCount } from 'cluster';

// https://github.com/microsoft/vscode/issues/65693
const MAX_CLI_LENGTH = 30000;
const isWindows = process.platform === 'win32';

export interface IVsr {
	path: string;
	version: string;
}

export interface IFileStatus {
	x: string;
	y: string;
	path: string;
	rename?: string;
}

export interface Stash {
	index: number;
	description: string;
}

interface MutableRemote extends Remote {
	fetchUrl?: string;
	pushUrl?: string;
	isReadOnly: boolean;
}

// TODO@eamodio: Move to git.d.ts once we are good with the api
/**
 * Log file options.
 */
export interface LogFileOptions {
	/** Optional. The maximum number of log entries to retrieve. */
	readonly maxEntries?: number | string;
	/** Optional. The Git sha (hash) to start retrieving log entries from. */
	readonly hash?: string;
	/** Optional. Specifies whether to start retrieving log entries in reverse order. */
	readonly reverse?: boolean;
	readonly sortByAuthorDate?: boolean;
}

function parseVersion(raw: string): string {
	let match = raw.match(/\(Versionr v([\d\.])\s/);
	if (match) {
		return match[1];
	}

	return "?";
}

function findSpecificVsr(path: string, onLookup: (path: string) => void): Promise<IVsr> {
	return new Promise<IVsr>((c, e) => {
		onLookup(path);

		const buffers: Buffer[] = [];
		const child = cp.spawn(path, ['--version']);
		child.stdout.on('data', (b: Buffer) => buffers.push(b));
		child.on('error', cpErrorHandler(e));
		child.on('exit', code => code ? e(new Error('Not found')) : c({ path, version: parseVersion(Buffer.concat(buffers).toString('utf8').trim()) }));
	});
}

function findVsrDarwin(onLookup: (path: string) => void): Promise<IVsr> {
	return new Promise<IVsr>((c, e) => {
		cp.exec('which vsr', (err, vsrPathBuffer) => {
			if (err) {
				return e('vsr not found');
			}

			const path = vsrPathBuffer.toString().replace(/^\s+|\s+$/g, '');

			function getVersion(path: string) {
				onLookup(path);

				// make sure vsr executes
				cp.exec('vsr --version', (err, stdout) => {

					if (err) {
						return e('vsr not found');
					}

					return c({ path, version: parseVersion(stdout.trim()) });
				});
			}

			if (path !== '/usr/bin/vsr') {
				return getVersion(path);
			}

			// must check if XCode is installed
			cp.exec('xcode-select -p', (err: any) => {
				if (err && err.code === 2) {
					// vsr is not installed, and launching /usr/bin/vsr
					// will prompt the user to install it

					return e('vsr not found');
				}

				getVersion(path);
			});
		});
	});
}

function findSystemVsrWin32(base: string, onLookup: (path: string) => void): Promise<IVsr> {
	if (!base) {
		return Promise.reject<IVsr>('Not found');
	}

	return findSpecificVsr(path.join(base, 'Versionr', 'vsr.exe'), onLookup);
}

function findVsrWin32InPath(onLookup: (path: string) => void): Promise<IVsr> {
	return Promise.reject<IVsr>('NYI');

	// const whichPromise = new Promise<string>((c, e) => which('vsr.exe', (err, path) => err ? e(err) : c(path)));
	// return whichPromise.then(path => findSpecificVsr(path, onLookup));
}

function findVsrWin32(onLookup: (path: string) => void): Promise<IVsr> {
	return findSystemVsrWin32(process.env['ProgramW6432'] as string, onLookup)
		.then(undefined, () => findSystemVsrWin32(process.env['ProgramFiles(x86)'] as string, onLookup))
		.then(undefined, () => findSystemVsrWin32(process.env['ProgramFiles'] as string, onLookup))
		.then(undefined, () => findSystemVsrWin32(path.join(process.env['LocalAppData'] as string, 'Programs'), onLookup))
		.then(undefined, () => findVsrWin32InPath(onLookup));
}

export function findVsr(hint: string | undefined, onLookup: (path: string) => void): Promise<IVsr> {
	const first = hint ? findSpecificVsr(hint, onLookup) : Promise.reject<IVsr>(null);

	return first
		.then(undefined, () => {
			switch (process.platform) {
				case 'darwin': return findVsrDarwin(onLookup);
				case 'win32': return findVsrWin32(onLookup);
				default: return findSpecificVsr('git', onLookup);
			}
		})
		.then(null, () => Promise.reject(new Error('Git installation not found.')));
}

export interface IExecutionResult<T extends string | Buffer> {
	exitCode: number;
	stdout: T;
	stderr: string;
}

function cpErrorHandler(cb: (reason?: any) => void): (reason?: any) => void {
	return err => {
		if (/ENOENT/.test(err.message)) {
			err = new GitError({
				error: err,
				message: 'Failed to execute git (ENOENT)',
				gitErrorCode: VsrErrorCodes.NotAGitRepository
			});
		}

		cb(err);
	};
}

export interface SpawnOptions extends cp.SpawnOptions {
	input?: string;
	encoding?: string;
	log?: boolean;
	cancellationToken?: CancellationToken;
	onSpawn?: (childProcess: cp.ChildProcess) => void;
}

async function exec(child: cp.ChildProcess, cancellationToken?: CancellationToken): Promise<IExecutionResult<Buffer>> {
	if (!child.stdout || !child.stderr) {
		throw new GitError({ message: 'Failed to get stdout or stderr from git process.' });
	}

	if (cancellationToken && cancellationToken.isCancellationRequested) {
		throw new GitError({ message: 'Cancelled' });
	}

	const disposables: IDisposable[] = [];

	const once = (ee: NodeJS.EventEmitter, name: string, fn: (...args: any[]) => void) => {
		ee.once(name, fn);
		disposables.push(toDisposable(() => ee.removeListener(name, fn)));
	};

	const on = (ee: NodeJS.EventEmitter, name: string, fn: (...args: any[]) => void) => {
		ee.on(name, fn);
		disposables.push(toDisposable(() => ee.removeListener(name, fn)));
	};

	let result = Promise.all<any>([
		new Promise<number>((c, e) => {
			once(child, 'error', cpErrorHandler(e));
			once(child, 'exit', c);
		}),
		new Promise<Buffer>(c => {
			const buffers: Buffer[] = [];
			on(child.stdout!, 'data', (b: Buffer) => buffers.push(b));
			once(child.stdout!, 'close', () => c(Buffer.concat(buffers)));
		}),
		new Promise<string>(c => {
			const buffers: Buffer[] = [];
			on(child.stderr!, 'data', (b: Buffer) => buffers.push(b));
			once(child.stderr!, 'close', () => c(Buffer.concat(buffers).toString('utf8')));
		})
	]) as Promise<[number, Buffer, string]>;

	if (cancellationToken) {
		const cancellationPromise = new Promise<[number, Buffer, string]>((_, e) => {
			onceEvent(cancellationToken.onCancellationRequested)(() => {
				try {
					child.kill();
				} catch (err) {
					// noop
				}

				e(new GitError({ message: 'Cancelled' }));
			});
		});

		result = Promise.race([result, cancellationPromise]);
	}

	try {
		const [exitCode, stdout, stderr] = await result;
		return { exitCode, stdout, stderr };
	} finally {
		dispose(disposables);
	}
}

export interface IGitErrorData {
	error?: Error;
	message?: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	gitErrorCode?: string;
	gitCommand?: string;
}

export class GitError {

	error?: Error;
	message: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	gitErrorCode?: string;
	gitCommand?: string;

	constructor(data: IGitErrorData) {
		if (data.error) {
			this.error = data.error;
			this.message = data.error.message;
		} else {
			this.error = undefined;
			this.message = '';
		}

		this.message = this.message || data.message || 'Git error';
		this.stdout = data.stdout;
		this.stderr = data.stderr;
		this.exitCode = data.exitCode;
		this.gitErrorCode = data.gitErrorCode;
		this.gitCommand = data.gitCommand;
	}

	toString(): string {
		let result = this.message + ' ' + JSON.stringify({
			exitCode: this.exitCode,
			gitErrorCode: this.gitErrorCode,
			gitCommand: this.gitCommand,
			stdout: this.stdout,
			stderr: this.stderr
		}, null, 2);

		if (this.error) {
			result += (<any>this.error).stack;
		}

		return result;
	}
}

export function isGitError(obj: any): obj is GitError {
	return obj instanceof GitError;
}

export interface IGitOptions {
	gitPath: string;
	version: string;
	env?: any;
}

function getGitErrorCode(stderr: string): string | undefined {
	if (/Another git process seems to be running in this repository|If no other git process is currently running/.test(stderr)) {
		return VsrErrorCodes.RepositoryIsLocked;
	} else if (/Authentication failed/i.test(stderr)) {
		return VsrErrorCodes.AuthenticationFailed;
	} else if (/Not a git repository/i.test(stderr)) {
		return VsrErrorCodes.NotAGitRepository;
	} else if (/bad config file/.test(stderr)) {
		return VsrErrorCodes.BadConfigFile;
	} else if (/cannot make pipe for command substitution|cannot create standard input pipe/.test(stderr)) {
		return VsrErrorCodes.CantCreatePipe;
	} else if (/Repository not found/.test(stderr)) {
		return VsrErrorCodes.RepositoryNotFound;
	} else if (/unable to access/.test(stderr)) {
		return VsrErrorCodes.CantAccessRemote;
	} else if (/branch '.+' is not fully merged/.test(stderr)) {
		return VsrErrorCodes.BranchNotFullyMerged;
	} else if (/Couldn\'t find remote ref/.test(stderr)) {
		return VsrErrorCodes.NoRemoteReference;
	} else if (/A branch named '.+' already exists/.test(stderr)) {
		return VsrErrorCodes.BranchAlreadyExists;
	} else if (/'.+' is not a valid branch name/.test(stderr)) {
		return VsrErrorCodes.InvalidBranchName;
	} else if (/Please,? commit your changes or stash them/.test(stderr)) {
		return VsrErrorCodes.DirtyWorkTree;
	}

	return undefined;
}

// https://github.com/microsoft/vscode/issues/89373
// https://github.com/git-for-windows/git/issues/2478
function sanitizePath(path: string): string {
	return path.replace(/^([a-z]):\\/i, (_, letter) => `${letter.toUpperCase()}:\\`);
}

const COMMIT_FORMAT = '%H%n%aN%n%aE%n%at%n%ct%n%P%n%B';

export class Vsr {

	readonly path: string;
	private env: any;

	private _onOutput = new EventEmitter();
	get onOutput(): EventEmitter { return this._onOutput; }

	constructor(options: IGitOptions) {
		this.path = options.gitPath;
		this.env = options.env || {};
	}

	open(repository: string, dotGit: string): Repository {
		return new Repository(this, repository, dotGit);
	}

	async init(repository: string): Promise<void> {
		await this.exec(repository, ['init']);
		return;
	}

	async clone(url: string, parentPath: string, progress: Progress<{ increment: number }>, cancellationToken?: CancellationToken): Promise<string> {
		let baseFolderName = decodeURI(url).replace(/[\/]+$/, '').replace(/^.*[\/\\]/, '').replace(/\.vsr$/, '') || 'repository';
		let folderName = baseFolderName;
		let folderPath = path.join(parentPath, folderName);
		let count = 1;

		while (count < 20 && await new Promise(c => exists(folderPath, c))) {
			folderName = `${baseFolderName}-${count++}`;
			folderPath = path.join(parentPath, folderName);
		}

		await mkdirp(parentPath);

		const onSpawn = (child: cp.ChildProcess) => {
			const decoder = new StringDecoder('utf8');
			const lineStream = new byline.LineStream({ encoding: 'utf8' });
			child.stderr!.on('data', (buffer: Buffer) => lineStream.write(decoder.write(buffer)));

			let totalProgress = 0;
			let previousProgress = 0;

			lineStream.on('data', (line: string) => {
				let match: RegExpMatchArray | null = null;


				// FIXME: This needs to change because, lol
				if (match = /Counting objects:\s*(\d+)%/i.exec(line)) {
					totalProgress = Math.floor(parseInt(match[1]) * 0.1);
				} else if (match = /Compressing objects:\s*(\d+)%/i.exec(line)) {
					totalProgress = 10 + Math.floor(parseInt(match[1]) * 0.1);
				} else if (match = /Receiving objects:\s*(\d+)%/i.exec(line)) {
					totalProgress = 20 + Math.floor(parseInt(match[1]) * 0.4);
				} else if (match = /Resolving deltas:\s*(\d+)%/i.exec(line)) {
					totalProgress = 60 + Math.floor(parseInt(match[1]) * 0.4);
				}

				if (totalProgress !== previousProgress) {
					progress.report({ increment: totalProgress - previousProgress });
					previousProgress = totalProgress;
				}
			});
		};

		try {
			await this.exec(parentPath, ['clone', url.includes(' ') ? encodeURI(url) : url, folderPath, '--progress'], { cancellationToken, onSpawn });
		} catch (err) {
			if ( isGitError(err)) {
				if (err.stderr) {
					err.stderr = err.stderr.replace(/^Cloning.+$/m, '').trim();
					err.stderr = err.stderr.replace(/^ERROR:\s+/, '').trim();
				}
			}

			throw err;
		}

		return folderPath;
	}

	async getRepositoryRoot(repositoryPath: string): Promise<string> {
		const result = await this.exec(repositoryPath, ['root']);
		return result.stdout.trim();
	}

	async getRepositoryDotVersionr(repositoryPath: string): Promise<string> {
		const root = await this.getRepositoryRoot(repositoryPath);

		return path.normalize(path.join(root, '.versionr'));
	}

	async exec(cwd: string, args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
		options = assign({ cwd }, options || {});
		return await this._exec(args, options);
	}

	async exec2(args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
		return await this._exec(args, options);
	}

	stream(cwd: string, args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		options = assign({ cwd }, options || {});
		return this.spawn(args, options);
	}

	private async _exec(args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
		// disable console colour output
		args.push('--nocolours');
		
		const child = this.spawn(args, options);

		if (options.onSpawn) {
			options.onSpawn(child);
		}

		if (options.input) {
			child.stdin!.end(options.input, 'utf8');
		}

		const bufferResult = await exec(child, options.cancellationToken);

		if (options.log !== false && bufferResult.stderr.length > 0) {
			this.log(`${bufferResult.stderr}\n`);
		}

		let encoding = options.encoding || 'utf8';
		encoding = iconv.encodingExists(encoding) ? encoding : 'utf8';

		const result: IExecutionResult<string> = {
			exitCode: bufferResult.exitCode,
			stdout: iconv.decode(bufferResult.stdout, encoding),
			stderr: bufferResult.stderr
		};

		if (bufferResult.exitCode) {
			return Promise.reject<IExecutionResult<string>>(new GitError({
				message: 'Failed to execute vsr',
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				gitErrorCode: getGitErrorCode(result.stderr),
				gitCommand: args[0]
			}));
		}

		return result;
	}

	spawn(args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		if (!this.path) {
			throw new Error('vsr could not be found in the system.');
		}

		if (!options) {
			options = {};
		}

		if (!options.stdio && !options.input) {
			options.stdio = ['ignore', null, null]; // Unless provided, ignore stdin and leave default streams for stdout and stderr
		}

		options.env = assign({}, process.env, this.env, options.env || {}, {
			VSCODE_GIT_COMMAND: args[0],
			LC_ALL: 'en_US.UTF-8',
			LANG: 'en_US.UTF-8',
			GIT_PAGER: 'cat'
		});
		
		if (options.cwd) {
			options.cwd = sanitizePath(options.cwd);
		}

		// ensure that colour codes aren't injected into the output
		args.push('--nocolours');
		const child = cp.spawn(this.path, args, options);
		
		if (options.log !== false) {
			const startTime = Date.now();
			child.on('exit', (_) => {
				const now = new Date();
				// hours as (HH) format
				let hours = ("0" + now.getHours()).slice(-2);

				// minutes as (mm) format
				let minutes = ("0" + now.getMinutes()).slice(-2);

				// seconds as (ss) format
				let seconds = ("0" + now.getSeconds()).slice(-2);
				this.log("[" + hours + ":" + minutes + ":" + seconds + `] > vsr ${args.join(' ')} [${Date.now() - startTime}ms]\n`);				
			});
		}
		return child;
	}

	private log(output: string): void {
		this._onOutput.emit('log', output);
	}
}

export interface Commit {
	hash: string;
	message: string;
	parents: string[];
	authorDate?: Date;
	authorName?: string;
	authorEmail?: string;
	commitDate?: Date;
}

interface Serializable<T> {
	deserialize(input: Object): T;
}

export class JsonStatus implements Serializable<JsonStatus> {
	Version: string = "";
	Branch: JsonBranch = new JsonBranch;
	Resources: JsonResource[] = [];

	deserialize(input: any): JsonStatus {
		this.Version = input.Version;
		this.Branch = new JsonBranch().deserialize(input.Branch);
		input.Resources.forEach((resource: any) => {
			this.Resources.push(new JsonResource().deserialize(resource));
		});
		return this;
	}
}

export class JsonBranch implements Serializable<JsonBranch> {
	Name: string = "";
	Revision: number = 0;
	IsTerminus: boolean = false;
	Heads: Array<JsonHead> = [];

	deserialize(input: any): JsonBranch {
		this.Name = input.Name;
		this.Revision = input.Revision;
		this.IsTerminus = input.IsTerminus;

		input.Heads.forEach((head: any) => {
			this.Heads.push(new JsonHead().deserialize(head));
		});

		return this;
	}
}

export class JsonHead implements Serializable<JsonHead> {
	ID: string = "";
	Name: string = "";
	Timestamp: string = "";
	Author: string = "";

	deserialize(input: any): JsonHead {
		this.ID = input.ID;
		this.Name = input.Name;
		this.Timestamp = input.Timestamp;
		this.Author = input.Author;
		return this;
	}
}

export class JsonResource implements Serializable<JsonResource> {
	Staged: boolean = false;
	Status: string = "";
	StatusCode: string = "";
	ReadOnly: boolean = false;
	CurrentName: string = "";
	CanonicalName: string = "";
	IsFile: boolean = false;
	IsDirectory: boolean = false;
	Hash: string = "";
	Length: number = 0;
	Removed: boolean = false;

	deserialize(input: any): JsonResource {
		this.Staged = input.Staged;
		this.Status = input.Status;
		this.StatusCode = input.StatusCode;
		this.ReadOnly = input.ReadOnly;
		this.CurrentName = input.CurrentName;
		this.CanonicalName = input.CanonicalName;
		this.IsFile = input.IsFile;
		this.IsDirectory = input.IsDirectory;
		this.Hash = input.Hash;
		this.Length = input.Length;
		this.Removed = input.Removed;

		return this;
	}

	toFileStatus(): IFileStatus {

		// x = staged
		// y = unstaged

		let s = '';
		let x = '';
		let y = '';

		if (this.Staged) {

			switch (this.Status) {
				case "modified": x = 'M'; break;
				case "added": x = 'A'; break;
				case "deleted": x = 'D'; break;
				case "copied": x = 'C'; break;
				case "renamed": x = 'R'; break;
			}	

		} else {
			switch (this.Status) {
				case "changed": y = 'M'; break;
				case "added": y = 'A'; break;
				case "deleted": y = 'D'; break;
				case "copied": y = 'C'; break;
				case "unversioned": x = '?'; y = '?'; break;
				case "ignored": x = '!'; y = '!'; break;
			}
		}

		return {
			x: x,
			y: y,
			rename: (this.CurrentName !== this.CanonicalName) ? this.CurrentName : "",
			path: this.CurrentName
		};
	}
}

export class VsrStatusParser {

	private lastRaw = '';
	private fileStatus: IFileStatus[] = [];
	private repoStatus: JsonStatus = new JsonStatus;

	// private branchStatus: Branch;
	// private headsStatus: Ref[];
	// private headStatus: Ref;

	get status(): IFileStatus[] {
		return this.fileStatus;
	}

	get vsrStatus(): JsonStatus {
		return this.vsrStatus;
	}

	update(raw: string): void {

		let status = JSON.parse(raw);

		this.repoStatus = new JsonStatus().deserialize(status);

		this.repoStatus.Resources.forEach(resource => {
			this.fileStatus.push( resource.toFileStatus() );
		});
	}

	// TODO: Add support for processing Branches and heads, maybe memoize this as well

}

export interface Submodule {
	name: string;
	path: string;
	url: string;
}

export function parseGitmodules(raw: string): Submodule[] {
	const regex = /\r?\n/g;
	let position = 0;
	let match: RegExpExecArray | null = null;

	const result: Submodule[] = [];
	let submodule: Partial<Submodule> = {};

	function parseLine(line: string): void {
		const sectionMatch = /^\s*\[submodule "([^"]+)"\]\s*$/.exec(line);

		if (sectionMatch) {
			if (submodule.name && submodule.path && submodule.url) {
				result.push(submodule as Submodule);
			}

			const name = sectionMatch[1];

			if (name) {
				submodule = { name };
				return;
			}
		}

		if (!submodule) {
			return;
		}

		const propertyMatch = /^\s*(\w+)\s+=\s+(.*)$/.exec(line);

		if (!propertyMatch) {
			return;
		}

		const [, key, value] = propertyMatch;

		switch (key) {
			case 'path': submodule.path = value; break;
			case 'url': submodule.url = value; break;
		}
	}

	while (match = regex.exec(raw)) {
		parseLine(raw.substring(position, match.index));
		position = match.index + match[0].length;
	}

	parseLine(raw.substring(position));

	if (submodule.name && submodule.path && submodule.url) {
		result.push(submodule as Submodule);
	}

	return result;
}

const commitRegex = /([0-9a-f]{40})\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)(?:\n([^]*?))?(?:\x00)/gm;

export function parseGitCommits(data: string): Commit[] {
	let commits: Commit[] = [];

	let ref;
	let authorName;
	let authorEmail;
	let authorDate;
	let commitDate;
	let parents;
	let message;
	let match;

	do {
		match = commitRegex.exec(data);
		if (match === null) {
			break;
		}

		[, ref, authorName, authorEmail, authorDate, commitDate, parents, message] = match;

		if (message[message.length - 1] === '\n') {
			message = message.substr(0, message.length - 1);
		}

		// Stop excessive memory usage by using substr -- https://bugs.chromium.org/p/v8/issues/detail?id=2869
		commits.push({
			hash: ` ${ref}`.substr(1),
			message: ` ${message}`.substr(1),
			parents: parents ? parents.split(' ') : [],
			authorDate: new Date(Number(authorDate) * 1000),
			authorName: ` ${authorName}`.substr(1),
			authorEmail: ` ${authorEmail}`.substr(1),
			commitDate: new Date(Number(commitDate) * 1000),
		});
	} while (true);

	return commits;
}

interface LsTreeElement {
	mode: string;
	type: string;
	object: string;
	size: string;
	file: string;
}

export function parseLsTree(raw: string): LsTreeElement[] {
	return raw.split('\n')
		.filter(l => !!l)
		.map(line => /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line)!)
		.filter(m => !!m)
		.map(([, mode, type, object, size, file]) => ({ mode, type, object, size, file }));
}

interface LsFilesElement {
	mode: string;
	object: string;
	stage: string;
	file: string;
}

export function parseLsFiles(raw: string): LsFilesElement[] {
	return raw.split('\n')
		.filter(l => !!l)
		.map(line => /^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line)!)
		.filter(m => !!m)
		.map(([, mode, object, stage, file]) => ({ mode, object, stage, file }));
}

export interface PullOptions {
	unshallow?: boolean;
	tags?: boolean;
	readonly cancellationToken?: CancellationToken;
}

export enum ForcePushMode {
	Force,
	ForceWithLease
}

export class Repository {

	constructor(
		private _git: Vsr,
		private repositoryRoot: string,
		readonly dotGit: string
	) { }

	get git(): Vsr {
		return this._git;
	}

	get root(): string {
		return this.repositoryRoot;
	}

	// TODO@Joao: rename to exec
	async run(args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
		return await this.git.exec(this.repositoryRoot, args, options);
	}

	stream(args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		return this.git.stream(this.repositoryRoot, args, options);
	}

	spawn(args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		return this.git.spawn(args, options);
	}

	async config(scope: string, key: string, value: any = null, options: SpawnOptions = {}): Promise<string> {
		const args = ['config'];

		if (scope) {
			args.push('--' + scope);
		}

		args.push(key);

		if (value) {
			args.push(value);
		}

		const result = await this.run(args, options);
		return result.stdout.trim();
	}

	async getConfigs(scope: string): Promise<{ key: string; value: string; }[]> {
		const args = ['config'];

		if (scope) {
			args.push('--' + scope);
		}

		args.push('-l');

		const result = await this.run(args);
		const lines = result.stdout.trim().split(/\r|\r\n|\n/);

		return lines.map(entry => {
			const equalsIndex = entry.indexOf('=');
			return { key: entry.substr(0, equalsIndex), value: entry.substr(equalsIndex + 1) };
		});
	}

	async log(options?: LogOptions): Promise<Commit[]> {
		const maxEntries = options?.maxEntries ?? 32;
		const args = ['log', `-n${maxEntries}`, `--format=${COMMIT_FORMAT}`, '-l', '--'];
		if (options?.path) {
			args.push(options.path);
		}

		const result = await this.run(args);
		if (result.exitCode) {
			// An empty repo
			return [];
		}

		return parseGitCommits(result.stdout);
	}

	async logFile(uri: Uri, options?: LogFileOptions): Promise<Commit[]> {
		const args = ['log', `--format=${COMMIT_FORMAT}`, '-j'];

		if (options?.maxEntries && !options?.reverse) {
			args.push(`-n${options.maxEntries}`);
		}

		if (options?.hash) {
			// If we are reversing, we must add a range (with HEAD) because we are using --ancestry-path for better reverse walking
			if (options?.reverse) {
				args.push('--reverse', '--ancestry-path', `${options.hash}..HEAD`);
			} else {
				args.push(options.hash);
			}
		}

		if (options?.sortByAuthorDate) {
			args.push('--author-date-order');
		}

		args.push('--', uri.fsPath);

		const result = await this.run(args);
		if (result.exitCode) {
			// No file history, e.g. a new file or untracked
			return [];
		}

		return parseGitCommits(result.stdout);
	}

	async bufferString(object: string, encoding: string = 'utf8', autoGuessEncoding = false): Promise<string> {
		const stdout = await this.buffer(object);

		if (autoGuessEncoding) {
			encoding = detectEncoding(stdout) || encoding;
		}

		encoding = iconv.encodingExists(encoding) ? encoding : 'utf8';

		return iconv.decode(stdout, encoding);
	}

	async buffer(object: string): Promise<Buffer> {

		let cmd: string[] = ['show', '-d'];

		// extract version if defined
		const objectInfo = object.split(":");
		if (objectInfo[0] !== "") {
			cmd.push('-v',objectInfo[0]);
		}
		cmd.push(objectInfo[1]);

		const child = this.stream(cmd);

		if (!child.stdout) {
			return Promise.reject<Buffer>('Can\'t open file from vsr');
		}

		const { exitCode, stdout, stderr } = await exec(child);

		if (exitCode) {
			const err = new GitError({
				message: 'Could not show object.',
				exitCode
			});

			if (/exists on disk, but not in/.test(stderr)) {
				err.gitErrorCode = VsrErrorCodes.WrongCase;
			}

			return Promise.reject<Buffer>(err);
		}

		return stdout;
	}

	async getObjectDetails(treeish: string, path: string): Promise<{ mode: string, object: string, size: number }> {
		const parser = new VsrStatusParser();

		const { stdout } = await this.run(['status', '-j', '-a', sanitizePath(path)]);
		parser.update(stdout);

		if (parser.status.length === 0) {
			throw new GitError({ message: 'Path not known by vsr', gitErrorCode: VsrErrorCodes.UnknownPath });
		}

		let status = parser.vsrStatus.Resources[0];
		// FIXME: This is totally cheating
		let perms = "100644";
		return {
			mode: perms,
			object: status.Hash,
			size: status.Length
		};

		// if (!treeish) { // index
		// 	const elements = await this.lsfiles(path);

		// 	if (elements.length === 0) {
		// 		throw new GitError({ message: 'Path not known by git', gitErrorCode: VsrErrorCodes.UnknownPath });
		// 	}

		// 	const { mode, object } = elements[0];
		// 	const catFile = await this.run(['cat-file', '-s', object]);
		// 	const size = parseInt(catFile.stdout);

		// 	return { mode, object, size };
		// }

		// const elements = await this.lstree(treeish, path);

		// if (elements.length === 0) {
		// 	throw new GitError({ message: 'Path not known by git', gitErrorCode: VsrErrorCodes.UnknownPath });
		// }

		// const { mode, object, size } = elements[0];
		// return { mode, object, size: parseInt(size) };
	}

	async lstree(treeish: string, path: string): Promise<LsTreeElement[]> {
		const { stdout } = await this.run(['ls-tree', '-l', treeish, '--', sanitizePath(path)]);
		return parseLsTree(stdout);
	}

	async lsfiles(path: string): Promise<LsFilesElement[]> {
		const { stdout } = await this.run(['ls-files', '--stage', '--', sanitizePath(path)]);
		return parseLsFiles(stdout);
	}

	async getGitRelativePath(ref: string, relativePath: string): Promise<string> {
		const relativePathLowercase = relativePath.toLowerCase();
		const dirname = path.posix.dirname(relativePath) + '/';
		const elements: { file: string; }[] = ref ? await this.lstree(ref, dirname) : await this.lsfiles(dirname);
		const element = elements.filter(file => file.file.toLowerCase() === relativePathLowercase)[0];

		if (!element) {
			throw new GitError({ message: 'Git relative path not found.' });
		}

		return element.file;
	}

	async detectObjectType(object: string): Promise<{ mimetype: string, encoding?: string }> {
		const child = await this.stream(['show', object]);
		const buffer = await readBytes(child.stdout!, 4100);

		try {
			child.kill();
		} catch (err) {
			// noop
		}

		const encoding = detectUnicodeEncoding(buffer);
		let isText = true;

		if (encoding !== Encoding.UTF16be && encoding !== Encoding.UTF16le) {
			for (let i = 0; i < buffer.length; i++) {
				if (buffer.readInt8(i) === 0) {
					isText = false;
					break;
				}
			}
		}

		if (!isText) {
			const result = filetype(buffer);

			if (!result) {
				return { mimetype: 'application/octet-stream' };
			} else {
				return { mimetype: result.mime };
			}
		}

		if (encoding) {
			return { mimetype: 'text/plain', encoding };
		} else {
			// TODO@JOAO: read the setting OUTSIDE!
			return { mimetype: 'text/plain' };
		}
	}

	async apply(patch: string, reverse?: boolean): Promise<void> {
		const args = ['apply', patch];

		if (reverse) {
			args.push('-R');
		}

		try {
			await this.run(args);
		} catch (err) {
			if (isGitError(err)) {
				if (/patch does not apply/.test(err.stderr?.toString() || '')) {
					err.gitErrorCode = VsrErrorCodes.PatchDoesNotApply;
				}
			}

			throw err;
		}
	}

	async diff(cached = false): Promise<string> {
		const args = ['diff'];

		if (cached) {
			args.push('--cached');
		}

		const result = await this.run(args);
		return result.stdout;
	}

	diffWithHEAD(): Promise<Change[]>;
	diffWithHEAD(path: string): Promise<string>;
	diffWithHEAD(path?: string | undefined): Promise<string | Change[]>;
	async diffWithHEAD(path?: string | undefined): Promise<string | Change[]> {
		if (!path) {
			return await this.diffFiles(false);
		}

		const args = ['diff', '--', sanitizePath(path)];
		const result = await this.run(args);
		return result.stdout;
	}

	diffWith(ref: string): Promise<Change[]>;
	diffWith(ref: string, path: string): Promise<string>;
	diffWith(ref: string, path?: string | undefined): Promise<string | Change[]>;
	async diffWith(ref: string, path?: string): Promise<string | Change[]> {
		if (!path) {
			return await this.diffFiles(false, ref);
		}

		const args = ['diff', ref, '--', sanitizePath(path)];
		const result = await this.run(args);
		return result.stdout;
	}

	diffIndexWithHEAD(): Promise<Change[]>;
	diffIndexWithHEAD(path: string): Promise<string>;
	diffIndexWithHEAD(path?: string | undefined): Promise<string | Change[]>;
	async diffIndexWithHEAD(path?: string): Promise<string | Change[]> {
		if (!path) {
			return await this.diffFiles(true);
		}

		const args = ['diff', '--cached', '--', sanitizePath(path)];
		const result = await this.run(args);
		return result.stdout;
	}

	diffIndexWith(ref: string): Promise<Change[]>;
	diffIndexWith(ref: string, path: string): Promise<string>;
	diffIndexWith(ref: string, path?: string | undefined): Promise<string | Change[]>;
	async diffIndexWith(ref: string, path?: string): Promise<string | Change[]> {
		if (!path) {
			return await this.diffFiles(true, ref);
		}

		const args = ['diff', '--cached', ref, '--', sanitizePath(path)];
		const result = await this.run(args);
		return result.stdout;
	}

	async diffBlobs(object1: string, object2: string): Promise<string> {
		const args = ['diff', object1, object2];
		const result = await this.run(args);
		return result.stdout;
	}

	diffBetween(ref1: string, ref2: string): Promise<Change[]>;
	diffBetween(ref1: string, ref2: string, path: string): Promise<string>;
	diffBetween(ref1: string, ref2: string, path?: string | undefined): Promise<string | Change[]>;
	async diffBetween(ref1: string, ref2: string, path?: string): Promise<string | Change[]> {
		const range = `${ref1}...${ref2}`;
		if (!path) {
			return await this.diffFiles(false, range);
		}

		const args = ['diff', range, '--', sanitizePath(path)];
		const result = await this.run(args);

		return result.stdout.trim();
	}

	private async diffFiles(cached: boolean, ref?: string): Promise<Change[]> {
		const args = ['diff', '--name-status', '-j', '--diff-filter=ADMR'];
		if (cached) {
			args.push('--cached');
		}

		if (ref) {
			args.push(ref);
		}

		const gitResult = await this.run(args);
		if (gitResult.exitCode) {
			return [];
		}

		const entries = gitResult.stdout.split('\x00');
		let index = 0;
		const result: Change[] = [];

		entriesLoop:
		while (index < entries.length - 1) {
			const change = entries[index++];
			const resourcePath = entries[index++];
			if (!change || !resourcePath) {
				break;
			}

			const originalUri = URI.file(path.isAbsolute(resourcePath) ? resourcePath : path.join(this.repositoryRoot, resourcePath));
			let status: Status = Status.UNTRACKED;

			// Copy or Rename status comes with a number, e.g. 'R100'. We don't need the number, so we use only first character of the status.
			switch (change[0]) {
				case 'M':
					status = Status.MODIFIED;
					break;

				case 'A':
					status = Status.INDEX_ADDED;
					break;

				case 'D':
					status = Status.DELETED;
					break;

				// Rename contains two paths, the second one is what the file is renamed/copied to.
				case 'R':
					if (index >= entries.length) {
						break;
					}

					const newPath = entries[index++];
					if (!newPath) {
						break;
					}

					const uri = URI.file(path.isAbsolute(newPath) ? newPath : path.join(this.repositoryRoot, newPath));
					result.push({
						uri,
						renameUri: uri,
						originalUri,
						status: Status.INDEX_RENAMED
					});

					continue;

				default:
					// Unknown status
					break entriesLoop;
			}

			result.push({
				status,
				originalUri,
				uri: originalUri,
				renameUri: originalUri,
			});
		}

		return result;
	}

	async getMergeBase(ref1: string, ref2: string): Promise<string> {
		const args = ['merge-base', ref1, ref2];
		const result = await this.run(args);

		return result.stdout.trim();
	}

	async hashObject(data: string): Promise<string> {
		const args = ['hash-object', '-w', '--stdin'];
		const result = await this.run(args, { input: data });

		return result.stdout.trim();
	}

	async add(paths: string[], opts?: { update?: boolean }): Promise<void> {
		const args = ['add'];

		if (opts && opts.update) {
			args.push('-u');
		} else {
			args.push('-A');
		}

		args.push('--');

		if (paths && paths.length) {
			args.push.apply(args, paths.map(sanitizePath));
		} else {
			args.push('.');
		}

		await this.run(args);
	}

	async rm(paths: string[]): Promise<void> {
		const args = ['rm', '--'];

		if (!paths || !paths.length) {
			return;
		}

		args.push(...paths.map(sanitizePath));

		await this.run(args);
	}

	async stage(path: string, data: string): Promise<void> {
		const child = this.stream(['hash-object', '--stdin', '-w', '--path', sanitizePath(path)], { stdio: [null, null, null] });
		child.stdin!.end(data, 'utf8');

		const { exitCode, stdout } = await exec(child);
		const hash = stdout.toString('utf8');

		if (exitCode) {
			throw new GitError({
				message: 'Could not hash object.',
				exitCode: exitCode
			});
		}

		const treeish = await this.getCommit('HEAD').then(() => 'HEAD', () => '');
		let mode: string;
		let add: string = '';

		try {
			const details = await this.getObjectDetails(treeish, path);
			mode = details.mode;
		} catch (err) {
			if (isGitError(err)) {
				if (err.gitErrorCode !== VsrErrorCodes.UnknownPath) {
					throw err;
				}
			}

			mode = '100644';
			add = '--add';
		}

		await this.run(['update-index', add, '--cacheinfo', mode, hash, path]);
	}

	async checkout(treeish: string, paths: string[], opts: { track?: boolean } = Object.create(null)): Promise<void> {
		const args = ['checkout', '-q'];

		if (opts.track) {
			args.push('--track');
		}

		if (treeish) {
			args.push(treeish);
		}

		try {
			if (paths && paths.length > 0) {
				for (const chunk of splitInChunks(paths.map(sanitizePath), MAX_CLI_LENGTH)) {
					await this.run([...args, '--', ...chunk]);
				}
			} else {
				await this.run(args);
			}
		} catch (err) {
			if (isGitError(err)) {
				if (/Please,? commit your changes or stash them/.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.DirtyWorkTree;
				}
			}

			throw err;
		}
	}

	async commit(message: string, opts: CommitOptions = Object.create(null)): Promise<void> {
		const args = ['commit', '-m', message];

		// const args = ['commit', '--quiet', '--allow-empty-message', '--file', '-'];

		// if (opts.all) {
		// 	args.push('--all');
		// }

		// if (opts.amend) {
		// 	args.push('--amend');
		// }

		// if (opts.signoff) {
		// 	args.push('--signoff');
		// }

		// if (opts.signCommit) {
		// 	args.push('-S');
		// }
		// if (opts.empty) {
		// 	args.push('--allow-empty');
		// }

		try {
			await this.run(args);
		} catch (commitErr) {
			await this.handleCommitError(commitErr);
		}
	}

	async rebaseAbort(): Promise<void> {
		await this.run(['rebase', '--abort']);
	}

	async rebaseContinue(): Promise<void> {
		const args = ['rebase', '--continue'];

		try {
			await this.run(args);
		} catch (commitErr) {
			await this.handleCommitError(commitErr);
		}
	}

	private async handleCommitError(commitErr: any): Promise<void> {
		if (/not possible because you have unmerged files/.test(commitErr.stderr || '')) {
			commitErr.gitErrorCode = VsrErrorCodes.UnmergedChanges;
			throw commitErr;
		}

		try {
			await this.run(['config', '--get-all', 'user.name']);
		} catch (err) {
			if (isGitError(err)) {
				err.gitErrorCode = VsrErrorCodes.NoUserNameConfigured;
				throw err;
			}
		}

		try {
			await this.run(['config', '--get-all', 'user.email']);
		} catch (err) {
			if (isGitError(err)) {
				err.gitErrorCode = VsrErrorCodes.NoUserEmailConfigured;
				throw err;
			}
		}

		throw commitErr;
	}

	async branch(name: string, checkout: boolean, ref?: string): Promise<void> {
		const args = checkout ? ['checkout', '-q', '-b', name, '--no-track'] : ['branch', '-q', name];

		if (ref) {
			args.push(ref);
		}

		await this.run(args);
	}

	async deleteBranch(name: string, force?: boolean): Promise<void> {
		const args = ['branch', force ? '-D' : '-d', name];
		await this.run(args);
	}

	async renameBranch(name: string): Promise<void> {
		const args = ['branch', '-m', name];
		await this.run(args);
	}

	async setBranchUpstream(name: string, upstream: string): Promise<void> {
		const args = ['branch', '--set-upstream-to', upstream, name];
		await this.run(args);
	}

	async deleteRef(ref: string): Promise<void> {
		const args = ['update-ref', '-d', ref];
		await this.run(args);
	}

	async merge(ref: string): Promise<void> {
		const args = ['merge', ref];

		try {
			await this.run(args);
		} catch (err) {
			if (isGitError(err)) {
				if (/^CONFLICT /m.test(err.stdout || '')) {
					err.gitErrorCode = VsrErrorCodes.Conflict;
				}
			}

			throw err;
		}
	}

	async tag(name: string, message?: string): Promise<void> {
		let args = ['tag'];

		if (message) {
			args = [...args, '-a', name, '-m', message];
		} else {
			args = [...args, name];
		}

		await this.run(args);
	}

	async deleteTag(name: string): Promise<void> {
		let args = ['tag', '-d', name];
		await this.run(args);
	}

	async clean(paths: string[]): Promise<void> {
		const pathsByGroup = groupBy(paths.map(sanitizePath), p => path.dirname(p));
		const groups = Object.keys(pathsByGroup).map(k => pathsByGroup[k]);

		const limiter = new Limiter(5);
		const promises: Promise<any>[] = [];

		for (const paths of groups) {
			for (const chunk of splitInChunks(paths, MAX_CLI_LENGTH)) {
				promises.push(limiter.queue(() => this.run(['clean', '-f', '-q', '--', ...chunk])));
			}
		}

		await Promise.all(promises);
	}

	async undo(): Promise<void> {
		await this.run(['clean', '-fd']);

		try {
			await this.run(['checkout', '--', '.']);
		} catch (err) {
			if (isGitError(err)) {
				if (/did not match any file\(s\) known to git\./.test(err.stderr || '')) {
					return;
				}
			}

			throw err;
		}
	}

	async reset(treeish: string, hard: boolean = false): Promise<void> {
		const args = ['reset', hard ? '--hard' : '--soft', treeish];
		await this.run(args);
	}

	async revert(treeish: string, paths: string[]): Promise<void> {
		const result = await this.run(['branch']);
		let args: string[];

		// In case there are no branches, we must use rm --cached
		if (!result.stdout) {
			args = ['rm', '--cached', '-r', '--'];
		} else {
			args = ['reset', '-q', treeish, '--'];
		}

		if (paths && paths.length) {
			args.push.apply(args, paths.map(sanitizePath));
		} else {
			args.push('.');
		}

		try {
			await this.run(args);
		} catch (err) {
			if (isGitError(err)) {
				// In case there are merge conflicts to be resolved, git reset will output
				// some "needs merge" data. We try to get around that.
				if (/([^:]+: needs merge\n)+/m.test(err.stdout || '')) {
					return;
				}
			}

			throw err;
		}
	}

	async addRemote(name: string, url: string): Promise<void> {
		const args = ['remote', 'add', name, url];
		await this.run(args);
	}

	async removeRemote(name: string): Promise<void> {
		const args = ['remote', 'remove', name];
		await this.run(args);
	}

	async renameRemote(name: string, newName: string): Promise<void> {
		const args = ['remote', 'rename', name, newName];
		await this.run(args);
	}

	async fetch(options: { remote?: string, ref?: string, all?: boolean, prune?: boolean, depth?: number, silent?: boolean } = {}): Promise<void> {
		const args = ['fetch'];
		const spawnOptions: SpawnOptions = {};

		if (options.remote) {
			args.push(options.remote);

			if (options.ref) {
				args.push(options.ref);
			}
		} else if (options.all) {
			args.push('--all');
		}

		if (options.prune) {
			args.push('--prune');
		}

		if (typeof options.depth === 'number') {
			args.push(`--depth=${options.depth}`);
		}

		if (options.silent) {
			spawnOptions.env = { 'VSCODE_GIT_FETCH_SILENT': 'true' };
		}

		try {
			await this.run(args, spawnOptions);
		} catch (err) {
			if (isGitError(err)) {
				if (/No remote repository specified\./.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.NoRemoteRepositorySpecified;
				} else if (/Could not read from remote repository/.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.RemoteConnectionError;
				}
			}

			throw err;
		}
	}

	async pull(rebase?: boolean, remote?: string, branch?: string, options: PullOptions = {}): Promise<void> {
		const args = ['pull'];

		if (options.tags) {
			args.push('--tags');
		}

		if (options.unshallow) {
			args.push('--unshallow');
		}

		if (rebase) {
			args.push('-r');
		}

		if (remote && branch) {
			args.push(remote);
			args.push(branch);
		}

		try {
			await this.run(args, options);
		} catch (err) {
			if (isGitError(err)) {
				if (/^CONFLICT \([^)]+\): \b/m.test(err.stdout || '')) {
					err.gitErrorCode = VsrErrorCodes.Conflict;
				} else if (/Please tell me who you are\./.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.NoUserNameConfigured;
				} else if (/Could not read from remote repository/.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.RemoteConnectionError;
				} else if (err.stderr != undefined && /Pull is not possible because you have unmerged files|Cannot pull with rebase: You have unstaged changes|Your local changes to the following files would be overwritten|Please, commit your changes before you can merge/i.test(err.stderr)) {
					err.stderr = err.stderr?.replace(/Cannot pull with rebase: You have unstaged changes/i, 'Cannot pull with rebase, you have unstaged changes');
					err.gitErrorCode = VsrErrorCodes.DirtyWorkTree;
				} else if (/cannot lock ref|unable to update local ref/i.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.CantLockRef;
				} else if (/cannot rebase onto multiple branches/i.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.CantRebaseMultipleBranches;
				}
			}

			throw err;
		}
	}

	async push(remote?: string, name?: string, setUpstream: boolean = false, tags = false, forcePushMode?: ForcePushMode): Promise<void> {
		const args = ['push'];

		if (forcePushMode === ForcePushMode.ForceWithLease) {
			args.push('--force-with-lease');
		} else if (forcePushMode === ForcePushMode.Force) {
			args.push('--force');
		}

		if (setUpstream) {
			args.push('-u');
		}

		if (tags) {
			args.push('--follow-tags');
		}

		if (remote) {
			args.push(remote);
		}

		if (name) {
			args.push(name);
		}

		try {
			await this.run(args);
		} catch (err) {
			if (isGitError(err)) {
				if (/^error: failed to push some refs to\b/m.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.PushRejected;
				} else if (/Could not read from remote repository/.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.RemoteConnectionError;
				} else if (/^fatal: The current branch .* has no upstream branch/.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.NoUpstreamBranch;
				}
			}

			throw err;
		}
	}

	async blame(path: string): Promise<string> {
		try {
			const args = ['blame', sanitizePath(path)];
			const result = await this.run(args);
			return result.stdout.trim();
		} catch (err) {
			if (isGitError(err)) {
				if (/^fatal: no such path/.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.NoPathFound;
				}
			}

			throw err;
		}
	}

	async createStash(message?: string, includeUntracked?: boolean): Promise<void> {
		try {
			const args = ['stash', 'push'];

			if (includeUntracked) {
				args.push('-u');
			}

			if (message) {
				args.push('-m', message);
			}

			await this.run(args);
		} catch (err) {
			if (isGitError(err)) {
				if (/No local changes to save/.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.NoLocalChanges;
				}
			}

			throw err;
		}
	}

	async popStash(index?: number): Promise<void> {
		const args = ['stash', 'pop'];
		await this.popOrApplyStash(args, index);
	}

	async applyStash(index?: number): Promise<void> {
		const args = ['stash', 'apply'];
		await this.popOrApplyStash(args, index);
	}

	private async popOrApplyStash(args: string[], index?: number): Promise<void> {
		try {
			if (typeof index === 'number') {
				args.push(`stash@{${index}}`);
			}

			await this.run(args);
		} catch (err) {
			if (isGitError(err)) {
				if (/No stash found/.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.NoStashFound;
				} else if (/error: Your local changes to the following files would be overwritten/.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.LocalChangesOverwritten;
				} else if (/^CONFLICT/m.test(err.stdout || '')) {
					err.gitErrorCode = VsrErrorCodes.StashConflict;
				}
			}

			throw err;
		}
	}

	async dropStash(index?: number): Promise<void> {
		const args = ['stash', 'drop'];

		if (typeof index === 'number') {
			args.push(`stash@{${index}}`);
		}

		try {
			await this.run(args);
		} catch (err) {
			if (isGitError(err)) {
				if (/No stash found/.test(err.stderr || '')) {
					err.gitErrorCode = VsrErrorCodes.NoStashFound;
				}
			}

			throw err;
		}
	}

	getStatus(limit = 5000): Promise<{ status: IFileStatus[]; didHitLimit: boolean; }> {
		return new Promise<{ status: IFileStatus[]; didHitLimit: boolean; }>((c, e) => {
			const parser = new VsrStatusParser();
			const env = { GIT_OPTIONAL_LOCKS: '0' };
			const child = this.stream(['status', '-j'], { env });

			const onExit = (exitCode: number) => {
				if (exitCode !== 0) {
					const stderr = stderrData.join('');
					return e(new GitError({
						message: 'Failed to execute vsr',
						stderr,
						exitCode,
						gitErrorCode: getGitErrorCode(stderr),
						gitCommand: 'status'
					}));
				}

				c({ status: parser.status, didHitLimit: false });
			};

			const onStdoutData = (raw: string) => {
				parser.update(raw);

				if (parser.status.length > limit) {
					child.removeListener('exit', onExit);
					child.stdout!.removeListener('data', onStdoutData);
					child.kill();

					c({ status: parser.status.slice(0, limit), didHitLimit: true });
				}
			};

			child.stdout!.setEncoding('utf8');
			child.stdout!.on('data', onStdoutData);

			const stderrData: string[] = [];
			child.stderr!.setEncoding('utf8');
			child.stderr!.on('data', raw => stderrData.push(raw as string));

			child.on('error', cpErrorHandler(e));
			child.on('exit', onExit);
		});
	}

	async getHEAD(): Promise<Ref> {
		try {
			const result = await this.run(['info']);
			
			if (!result.stdout) {
				throw new Error('Not in a branch');
			}

			// Parse HEAD version and branch name.  e.g
			// Version deeff0de-8df7-4267-bf4e-0c058f541e9c on branch "master" (rev 4)
			let match = result.stdout.match(/Version (\S+) on branch "(\S+)"/);
			if (match) {
				return { 
					name: match[2], 
					commit: match[1].trim(),
					type: RefType.Head 
				};
			} else {
				throw new Error('Error parsing HEAD');
			}

		} catch (err) {
			throw new Error('Error parsing HEAD');
		}
	}

	async findTrackingBranches(upstreamBranch: string): Promise<Branch[]> {
		const result = await this.run(['for-each-ref', '--format', '%(refname:short)%00%(upstream:short)', 'refs/heads']);
		return result.stdout.trim().split('\n')
			.map(line => line.trim().split('\0'))
			.filter(([_, upstream]) => upstream === upstreamBranch)
			.map(([ref]) => ({ name: ref, type: RefType.Head } as Branch));
	}

	async getRefs(opts?: { sort?: 'alphabetically' | 'committerdate', contains?: string }): Promise<Ref[]> {
		let r: Ref[] = [];
		return r;

		// const args = ['for-each-ref', '--format', '%(refname) %(objectname)'];

		// if (opts && opts.sort && opts.sort !== 'alphabetically') {
		// 	args.push('--sort', `-${opts.sort}`);
		// }

		// if (opts?.contains) {
		// 	args.push('--contains', opts.contains);
		// }

		// const result = await this.run(args);

		// const fn = (line: string): Ref | null => {
		// 	let match: RegExpExecArray | null;

		// 	if (match = /^refs\/heads\/([^ ]+) ([0-9a-f]{40})$/.exec(line)) {
		// 		return { name: match[1], commit: match[2], type: RefType.Head };
		// 	} else if (match = /^refs\/remotes\/([^/]+)\/([^ ]+) ([0-9a-f]{40})$/.exec(line)) {
		// 		return { name: `${match[1]}/${match[2]}`, commit: match[3], type: RefType.RemoteHead, remote: match[1] };
		// 	} else if (match = /^refs\/tags\/([^ ]+) ([0-9a-f]{40})$/.exec(line)) {
		// 		return { name: match[1], commit: match[2], type: RefType.Tag };
		// 	}

		// 	return null;
		// };

		// return result.stdout.trim().split('\n')
		// 	.filter(line => !!line)
		// 	.map(fn)
		// 	.filter(ref => !!ref) as Ref[];
	}

	async getStashes(): Promise<Stash[]> {
		const result = await this.run(['stash', 'list']);
		const regex = /^stash@{(\d+)}:(.+)$/;
		const rawStashes = result.stdout.trim().split('\n')
			.filter(b => !!b)
			.map(line => regex.exec(line) as RegExpExecArray)
			.filter(g => !!g)
			.map(([, index, description]: RegExpExecArray) => ({ index: parseInt(index), description }));

		return rawStashes;
	}

	async getRemotes(): Promise<Remote[]> {

		const remotesResult = await this.run(['list-remotes']);
		const trimmedOutput = remotesResult.stdout.trim();
		let remotes = trimmedOutput.split('\n')
			.filter(line => !!line)
			.map((line: string): Remote | null => {
				let match = line.match(/^Remote\s+"(\S+)"\s+is\s+(vsr:\/\/.*)$/);
				if (match) {
					return {
						name: match[1],
						pushUrl: match[2],
						isReadOnly: false,
					};
				}
				return null;
			})
			.filter(ref => !!ref) as Remote[];

		return remotes;

		// const result = await this.run(['list-remotes', '-j']);
		// const lines = result.stdout.trim().split('\n').filter(l => !!l);
		// const remotes: MutableRemote[] = [];

		// for (const line of lines) {
		// 	const parts = line.split(/\s/);
		// 	const [name, url, type] = parts;

		// 	let remote = remotes.find(r => r.name === name);

		// 	if (!remote) {
		// 		remote = { name, isReadOnly: false };
		// 		remotes.push(remote);
		// 	}

		// 	if (/fetch/i.test(type)) {
		// 		remote.fetchUrl = url;
		// 	} else if (/push/i.test(type)) {
		// 		remote.pushUrl = url;
		// 	} else {
		// 		remote.fetchUrl = url;
		// 		remote.pushUrl = url;
		// 	}

		// 	// https://github.com/Microsoft/vscode/issues/45271
		// 	remote.isReadOnly = remote.pushUrl === undefined || remote.pushUrl === 'no_push';
		// }

		// return remotes;
	}

	async getBranch(name: string): Promise<Branch> {
		if (name === 'HEAD') {
			return this.getHEAD();
		}

		let result = await this.run(['list-branches','-p', name]);

		if (!result.stdout || (!result.stdout && /^@/.test(name))) {
			return Promise.reject<Branch>(new Error('No such branch'));
		}

		let commit = "";
		let match = result.stdout.match(/(\S+)\s-\s(\S+).*/);
		if (match) {
			commit = match[2].trim();
		} else {
			return Promise.reject<Branch>(new Error('Error parsing branch info'));
		}

		try {
			const aheadResult = await this.run(['ahead', '--branch', name]);

			const upstreamInfo = aheadResult.stdout.trim();
			const lines = upstreamInfo.split('\n');
			const statusLine = lines[lines.length-1];

			let remote = "";
			match = lines[0].match(/Connected to Remote:\s(\S+).*/);
			if (!match) {
				// Check if there is a remote specified
				match = lines[0].match(/No provider connected to remote URL/);
				if (!match) {
					throw new Error(`Could not parse upstream branch: ${name}`);
				}
				// If there isn't an upstream, just return the current branch info
				return { name, type: RefType.Head, commit };
			}
			remote = match[0];

			match = statusLine.match(/Remote\s-\s(\S+)\s+-\sVersion:\s(\S+)\s\((\S+)\).*/);
			if (!match) {
				throw new Error(`Could not parse upstream branch status: ${name}`);
			}

			// FIXME: This is not returning the actual values because walking the history to 
			// calculate the version counts hasn't been implemented in Versionr
			let ahead = 0, behind = 0;
			switch (match[3]) {
				case 'ahead': ahead = 1; break;
				case 'behind': behind = 1; break;
			}

			let upstream = { remote: remote, name: name };
			return { 
				name, 
				type: RefType.Head, 
				commit, 
				upstream,
				ahead, 
				behind 
			};
		} catch (err) {
			if (isGitError(err)) {
				return { name, type: RefType.Head, commit };
			}

			throw new Error(`Error while parsing upstream branch status: ${name}`);
		}
	}

	async getBranches(query: BranchQuery): Promise<Ref[]> {
		const refs = await this.getRefs({ contains: query.contains });
		return refs.filter(value => (value.type !== RefType.Tag) && (query.remote || !value.remote));
	}

	// TODO: Support core.commentChar
	stripCommitMessageComments(message: string): string {
		return message.replace(/^\s*#.*$\n?/gm, '').trim();
	}

	async getMergeMessage(): Promise<string | undefined> {
		const mergeMsgPath = path.join(this.repositoryRoot, '.versionr', 'MERGE_MSG');

		try {
			const raw = await fs.readFile(mergeMsgPath, 'utf8');
			return this.stripCommitMessageComments(raw);
		} catch {
			return undefined;
		}
	}

	async getCommitTemplate(): Promise<string> {
		return '';
		try {
			const result = await this.run(['config', '--get', 'commit.template']);

			if (!result.stdout) {
				return '';
			}

			// https://github.com/git/git/blob/3a0f269e7c82aa3a87323cb7ae04ac5f129f036b/path.c#L612
			const homedir = os.homedir();
			let templatePath = result.stdout.trim()
				.replace(/^~([^\/]*)\//, (_, user) => `${user ? path.join(path.dirname(homedir), user) : homedir}/`);

			if (!path.isAbsolute(templatePath)) {
				templatePath = path.join(this.repositoryRoot, templatePath);
			}

			const raw = await fs.readFile(templatePath, 'utf8');
			return this.stripCommitMessageComments(raw);
		} catch (err) {
			if (isGitError(err)) {
				return '';
			}
		}
	}

	async getCommit(ref: string): Promise<Commit> {
		const result = await this.run(['show', '-s', `--format=${COMMIT_FORMAT}`, '-j', ref]);
		const commits = parseGitCommits(result.stdout);
		if (commits.length === 0) {
			return Promise.reject<Commit>('bad commit format');
		}
		return commits[0];
	}

	async updateSubmodules(paths: string[]): Promise<void> {
		const args = ['submodule', 'update', '--'];

		for (const chunk of splitInChunks(paths.map(sanitizePath), MAX_CLI_LENGTH)) {
			await this.run([...args, ...chunk]);
		}
	}

	async getSubmodules(): Promise<Submodule[]> {
		const gitmodulesPath = path.join(this.root, '.gitmodules');

		try {
			const gitmodulesRaw = await fs.readFile(gitmodulesPath, 'utf8');
			return parseGitmodules(gitmodulesRaw);
		} catch (err) {
			if (isGitError(err)) {
				if (/ENOENT/.test(err.message)) {
					return [];
				}
			}

			throw err;
		}
	}
}
