/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dirname, join, basename } from 'vs/base/common/path';
import { exists, readdir, readFile, rimraf } from 'vs/base/node/pfs';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import { localize } from 'vs/nls';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { INativeWorkbenchEnvironmentService } from 'vs/workbench/services/environment/electron-sandbox/environmentService';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { PerfviewInput } from 'vs/workbench/contrib/performance/browser/perfviewEditor';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
import { URI } from 'vs/base/common/uri';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IElectronService } from 'vs/platform/electron/electron-sandbox/electron';
import { IProductService } from 'vs/platform/product/common/productService';

export class StartupProfiler implements IWorkbenchContribution {

	constructor(
		@IDialogService private readonly _dialogService: IDialogService,
		@IWorkbenchEnvironmentService private readonly _environmentService: INativeWorkbenchEnvironmentService,
		@ITextModelService private readonly _textModelResolverService: ITextModelService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IExtensionService extensionService: IExtensionService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IElectronService private readonly _electronService: IElectronService,
		@IProductService private readonly _productService: IProductService
	) {
		// wait for everything to be ready
		Promise.all([
			lifecycleService.when(LifecyclePhase.Eventually),
			extensionService.whenInstalledExtensionsRegistered()
		]).then(() => {
			this._stopProfiling();
		});
	}

	private _stopProfiling(): void {

		const profileFilenamePrefix = this._environmentService.args['prof-startup-prefix'];
		if (!profileFilenamePrefix) {
			return;
		}

		const dir = dirname(profileFilenamePrefix);
		const prefix = basename(profileFilenamePrefix);

		const removeArgs: string[] = ['--prof-startup'];
		const markerFile = readFile(profileFilenamePrefix).then(value => removeArgs.push(...value.toString().split('|')))
			.then(() => rimraf(profileFilenamePrefix)) // (1) delete the file to tell the main process to stop profiling
			.then(() => new Promise<void>(resolve => { // (2) wait for main that recreates the fail to signal profiling has stopped
				const check = () => {
					exists(profileFilenamePrefix).then(exists => {
						if (exists) {
							resolve();
						} else {
							setTimeout(check, 500);
						}
					});
				};
				check();
			}))
			.then(() => rimraf(profileFilenamePrefix)); // (3) finally delete the file again

		markerFile.then(() => {
			return readdir(dir).then(files => files.filter(value => value.indexOf(prefix) === 0));
		}).then(files => {
			const profileFiles = files.reduce((prev, cur) => `${prev}${join(dir, cur)}\n`, '\n');

			return this._dialogService.confirm({
				type: 'info',
				message: localize('prof.message', "Successfully created profiles."),
				detail: localize('prof.detail', "Please create an issue and manually attach the following files:\n{0}", profileFiles),
				primaryButton: localize('prof.restartAndFileIssue', "Create Issue and Restart"),
				secondaryButton: localize('prof.restart', "Restart")
			}).then(res => {
				if (res.confirmed) {
					Promise.all<any>([
						this._electronService.showItemInFolder(URI.file(join(dir, files[0])).fsPath),
						this._createPerfIssue(files)
					]).then(() => {
						// keep window stable until restart is selected
						return this._dialogService.confirm({
							type: 'info',
							message: localize('prof.thanks', "Thanks for helping us."),
							detail: localize('prof.detail.restart', "A final restart is required to continue to use '{0}'. Again, thank you for your contribution.", this._productService.nameLong),
							primaryButton: localize('prof.restart', "Restart"),
							secondaryButton: undefined
						}).then(() => {
							// now we are ready to restart
							this._electronService.relaunch({ removeArgs });
						});
					});

				} else {
					// simply restart
					this._electronService.relaunch({ removeArgs });
				}
			});
		});
	}

	private async _createPerfIssue(files: string[]): Promise<void> {
		const reportIssueUrl = this._productService.reportIssueUrl;
		if (!reportIssueUrl) {
			return;
		}

		const ref = await this._textModelResolverService.createModelReference(PerfviewInput.Uri);
		try {
			await this._clipboardService.writeText(ref.object.textEditorModel.getValue());
		} finally {
			ref.dispose();
		}

		const body = `
1. :warning: We have copied additional data to your clipboard. Make sure to **paste** here. :warning:
1. :warning: Make sure to **attach** these files from your *home*-directory: :warning:\n${files.map(file => `-\`${file}\``).join('\n')}
`;

		const baseUrl = reportIssueUrl;
		const queryStringPrefix = baseUrl.indexOf('?') === -1 ? '?' : '&';

		this._openerService.open(URI.parse(`${baseUrl}${queryStringPrefix}body=${encodeURIComponent(body)}`));
	}
}
