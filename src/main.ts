/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vscode-nls';
const localize = nls.loadMessageBundle();

import { ExtensionContext, workspace, window, Disposable, commands, Uri, OutputChannel, WorkspaceFolder } from 'vscode';
import { findVsr, Vsr, IVsr } from './vsr';
import { Model } from './model';
import { CommandCenter } from './commands';
import { GitFileSystemProvider } from './fileSystemProvider';
import { GitDecorations } from './decorationProvider';
import { Askpass } from './askpass';
import { toDisposable, filterEvent, eventToPromise } from './util';
import { VsrExtension } from './api/vsr';
import { GitProtocolHandler } from './protocolHandler';
import { GitExtensionImpl } from './api/extension';
import * as path from 'path';
import * as fs from 'fs';
import { registerAPICommands } from './api/api1';
import { TerminalEnvironmentManager } from './terminal';
import { GitError, isGitError } from './vsr';

const deactivateTasks: { (): Promise<any>; }[] = [];

export async function deactivate(): Promise<any> {
	for (const task of deactivateTasks) {
		await task();
	}
}

async function createModel(context: ExtensionContext, outputChannel: OutputChannel, disposables: Disposable[]): Promise<Model> {
	const pathHint = workspace.getConfiguration('vsr').get<string>('path');
	const info = await findVsr(pathHint, path => outputChannel.appendLine(localize('looking', "Looking for vsr in: {0}", path)));
	
	try {
		// This is a little bit of a workaround, but this is the friendliest way to introduce this setting
		if (workspace.workspaceFolders) {
			var folder = workspace.workspaceFolders[0];
			
			var filePath = path.join(folder.uri.fsPath, '.vscode', 'settings.json');

			// If the settings file does not exist
			if (!fs.existsSync(filePath)) {
				fs.mkdirSync(path.join(folder.uri.fsPath, '.vscode'));
				
				// Write a workspace settings file if one doesn't exist to exclude .versionr folder from 
				// the explorer tree and file watch / search operations
				const content = `{
		"files.exclude": {
			"**/.versionr": true
		},
		"files.watcherExclude": {
			"**/.versionr/**": true
		},
		"search.exclude": {
			"**/.versionr": true
		}
	}`;
				fs.writeFileSync(filePath, content, 'utf8');
			};
		}


	} catch (err) {
		console.warn(err);
	}
		
	const askpass = await Askpass.create(outputChannel, context.storagePath);
	disposables.push(askpass);

	const env = askpass.getEnv();
	const terminalEnvironmentManager = new TerminalEnvironmentManager(context, env);
	disposables.push(terminalEnvironmentManager);

	const git = new Vsr({ gitPath: info.path, version: info.version, env });
	const model = new Model(git, askpass, context.globalState, outputChannel);
	disposables.push(model);

	const onRepository = () => commands.executeCommand('setContext', 'gitOpenRepositoryCount', `${model.repositories.length}`);
	model.onDidOpenRepository(onRepository, null, disposables);
	model.onDidCloseRepository(onRepository, null, disposables);
	onRepository();

	outputChannel.appendLine(localize('using vsr', "Using vsr {0} from {1}", info.version, info.path));

	const onOutput = (str: string) => {
		const lines = str.split(/\r?\n/mg);

		while (/^\s*$/.test(lines[lines.length - 1])) {
			lines.pop();
		}

		outputChannel.appendLine(lines.join('\n'));
	};
	git.onOutput.addListener('log', onOutput);
	disposables.push(toDisposable(() => git.onOutput.removeListener('log', onOutput)));

	disposables.push(
		new CommandCenter(git, model, outputChannel),
		new GitFileSystemProvider(model),
		new GitDecorations(model),
		new GitProtocolHandler()
	);

	await checkGitVersion(info);

	return model;
}

async function isGitRepository(folder: WorkspaceFolder): Promise<boolean> {
	if (folder.uri.scheme !== 'file') {
		return false;
	}

	const dotGit = path.join(folder.uri.fsPath, '.versionr');

	try {
		const dotGitStat = await new Promise<fs.Stats>((c, e) => fs.stat(dotGit, (err, stat) => err ? e(err) : c(stat)));
		return dotGitStat.isDirectory();
	} catch (err) {
		return false;
	}
}

async function warnAboutMissingGit(): Promise<void> {
	const config = workspace.getConfiguration('vsr');
	const shouldIgnore = config.get<boolean>('ignoreMissingVsrWarning') === true;

	if (shouldIgnore) {
		return;
	}

	if (!workspace.workspaceFolders) {
		return;
	}

	const areGitRepositories = await Promise.all(workspace.workspaceFolders.map(isGitRepository));

	if (areGitRepositories.every(isGitRepository => !isGitRepository)) {
		return;
	}

	const download = localize('downloadgit', "Download Vsr");
	const neverShowAgain = localize('neverShowAgain', "Don't Show Again");
	const choice = await window.showWarningMessage(
		localize('notfound', "Vsr not found. Install it or configure it using the 'vsr.path' setting."),
		download,
		neverShowAgain
	);

	if (choice === download) {
		commands.executeCommand('vscode.open', Uri.parse('https://versionr.github.io/'));
	} else if (choice === neverShowAgain) {
		await config.update('ignoreMissingVsrWarning', true, true);
	}
}

export async function _activate(context: ExtensionContext): Promise<VsrExtension> {
	const disposables: Disposable[] = [];
	context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()));

	const outputChannel = window.createOutputChannel('Vsr');
	commands.registerCommand('vsr.showOutput', () => outputChannel.show());
	disposables.push(outputChannel);

	const { name, version, aiKey } = require('../package.json') as { name: string, version: string, aiKey: string };

	const config = workspace.getConfiguration('vsr', null);
	const enabled = config.get<boolean>('enabled');

	if (!enabled) {
		const onConfigChange = filterEvent(workspace.onDidChangeConfiguration, e => e.affectsConfiguration('vsr'));
		const onEnabled = filterEvent(onConfigChange, () => workspace.getConfiguration('vsr', null).get<boolean>('enabled') === true);
		const result = new GitExtensionImpl();

		eventToPromise(onEnabled).then(async () => result.model = await createModel(context, outputChannel, disposables));
		return result;
	}

	try {
		const model = await createModel(context, outputChannel, disposables);
		return new GitExtensionImpl(model);
	} catch (err) {
		if (isGitError(err)) {
			if (!/Git installation not found/.test(err.message || '')) {
				throw err;
			}

			console.warn(err.message);
			outputChannel.appendLine(err.message);
		}

		commands.executeCommand('setContext', 'vsr.missing', true);
		warnAboutMissingGit();

		return new GitExtensionImpl();
	}
}

export async function activate(context: ExtensionContext): Promise<VsrExtension> {
	const result = await _activate(context);
	context.subscriptions.push(registerAPICommands(result));
	return result;
}

async function checkGitVersion(info: IVsr): Promise<void> {
	const config = workspace.getConfiguration('vsr');
	const shouldIgnore = config.get<boolean>('ignoreLegacyWarning') === true;

	if (true) {//shouldIgnore) {
		return;
	}

	if (!/^[01]/.test(info.version)) {
		return;
	}

	const update = localize('updateVsr', "Update Vsr");
	const neverShowAgain = localize('neverShowAgain', "Don't Show Again");

	const choice = await window.showWarningMessage(
		localize('git20', "You seem to have vsr {0} installed. Code works best with vsr >= 2", info.version),
		update,
		neverShowAgain
	);

	if (choice === update) {
		commands.executeCommand('vscode.open', Uri.parse('https://git-scm.com/'));
	} else if (choice === neverShowAgain) {
		await config.update('ignoreLegacyWarning', true, true);
	}
}
