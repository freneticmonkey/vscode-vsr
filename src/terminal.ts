/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, workspace } from 'vscode';
import { filterEvent, IDisposable } from './util';

export class TerminalEnvironmentManager {

	private readonly disposable: IDisposable;

	private _enabled = false;
	private set enabled(enabled: boolean) {
		if (this._enabled === enabled) {
			return;
		}

		this._enabled = enabled;
		// TODO: This isn't using proposed API but this functionality still isn't available in the latest vscode API.  Determine how to handle this
		// this.context.environmentVariableCollection.clear();

		// if (enabled) {
		// 	for (const name of Object.keys(this.env)) {
		// 		this.context.environmentVariableCollection.replace(name, this.env[name]);
		// 	}
		// }
	}

	constructor(private readonly context: ExtensionContext, private readonly env: { [key: string]: string }) {
		this.disposable = filterEvent(workspace.onDidChangeConfiguration, e => e.affectsConfiguration('vsr'))
			(this.refresh, this);

		this.refresh();
	}

	private refresh(): void {
		const config = workspace.getConfiguration('vsr', null);
		this.enabled = config.get<boolean>('enabled', true) && config.get('terminalAuthentication', true);
	}

	dispose(): void {
		this.disposable.dispose();
	}
}
