/********************************************************************************
 * Copyright (C) 2017 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import * as cp from 'child_process';
import * as fuzzy from 'fuzzy';
import * as readline from 'readline';
import { rgPath } from 'vscode-ripgrep';
import { injectable, inject } from 'inversify';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/node/file-uri';
import { CancellationTokenSource, CancellationToken, ILogger, isWindows } from '@theia/core';
import { RawProcessFactory } from '@theia/process/lib/node';
import { FileSearchService } from '../common/file-search-service';
import * as path from 'path';

@injectable()
export class FileSearchServiceImpl implements FileSearchService {

    constructor(
        @inject(ILogger) protected readonly logger: ILogger,
        /** @deprecated since 1.7.0 */
        @inject(RawProcessFactory) protected readonly rawProcessFactory: RawProcessFactory,
    ) { }

    async find(searchPattern: string, options: FileSearchService.Options, clientToken?: CancellationToken): Promise<string[]> {
        const cancellationSource = new CancellationTokenSource();
        if (clientToken) {
            clientToken.onCancellationRequested(() => cancellationSource.cancel());
        }
        const token = cancellationSource.token;
        const opts = {
            fuzzyMatch: true,
            limit: Number.MAX_SAFE_INTEGER,
            useGitIgnore: true,
            ...options
        };

        const roots: FileSearchService.RootOptions = options.rootOptions || {};
        if (options.rootUris) {
            for (const rootUri of options.rootUris) {
                if (!roots[rootUri]) {
                    roots[rootUri] = {};
                }
            }
        }
        // eslint-disable-next-line guard-for-in
        for (const rootUri in roots) {
            const rootOptions = roots[rootUri];
            if (opts.includePatterns) {
                const includePatterns = rootOptions.includePatterns || [];
                rootOptions.includePatterns = [...includePatterns, ...opts.includePatterns];
            }
            if (opts.excludePatterns) {
                const excludePatterns = rootOptions.excludePatterns || [];
                rootOptions.excludePatterns = [...excludePatterns, ...opts.excludePatterns];
            }
            if (rootOptions.useGitIgnore === undefined) {
                rootOptions.useGitIgnore = opts.useGitIgnore;
            }
        }

        const exactMatches = new Set<string>();
        const fuzzyMatches = new Set<string>();

        if (isWindows) {
            // Allow users on Windows to search for paths using either forwards or backwards slash
            searchPattern = searchPattern.replace(/\//g, '\\');
        }

        const stringPattern = searchPattern.toLocaleLowerCase();
        await Promise.all(Object.keys(roots).map(async root => {
            try {
                const rootUri = new URI(root);
                const rootPath = FileUri.fsPath(rootUri);
                const rootOptions = roots[root];
                await this.doFind(rootUri, rootOptions, candidate => {
                    // Convert OS-native candidate path to a file URI string
                    const fileUri = FileUri.create(path.resolve(rootPath, candidate)).toString();
                    // Skip results that have already been matched.
                    if (exactMatches.has(fileUri) || fuzzyMatches.has(fileUri)) {
                        return;
                    }
                    if (!searchPattern || searchPattern === '*' || candidate.toLocaleLowerCase().indexOf(stringPattern) !== -1) {
                        exactMatches.add(fileUri);
                    } else if (opts.fuzzyMatch && fuzzy.test(searchPattern, candidate)) {
                        fuzzyMatches.add(fileUri);
                    }
                    // Preemptively terminate the search when the list of exact matches reaches the limit.
                    if (exactMatches.size === opts.limit) {
                        cancellationSource.cancel();
                    }
                }, token);
            } catch (e) {
                console.error('Failed to search:', root, e);
            }
        }));
        if (clientToken && clientToken.isCancellationRequested) {
            return [];
        }
        // Return the list of results limited by the search limit.
        const sortedFuzzyMatches = [...fuzzyMatches].sort((a, b) => this.compareUris(a, b, searchPattern));
        return [...exactMatches, ...sortedFuzzyMatches].slice(0, opts.limit);
    }

    private doFind(rootUri: URI, options: FileSearchService.BaseOptions, accept: (fileUri: string) => void, token: CancellationToken): Promise<void> {
        return new Promise((resolve, reject) => {
            const cwd = FileUri.fsPath(rootUri);
            const args = this.getSearchArgs(options);
            const ripgrep = cp.spawn(rgPath, args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
            ripgrep.on('error', reject);
            ripgrep.on('exit', (code, signal) => {
                if (typeof code === 'number' && code !== 0) {
                    reject(new Error(`"${rgPath}" exited with code: ${code}`));
                } else if (typeof signal === 'string') {
                    reject(new Error(`"${rgPath}" was terminated by signal: ${signal}`));
                }
            });
            token.onCancellationRequested(() => {
                ripgrep.kill(); // most likely sends a signal.
                resolve(); // avoid rejecting for no good reason.
            });
            const lineReader = readline.createInterface({
                input: ripgrep.stdout,
                crlfDelay: Infinity,
            });
            lineReader.on('line', line => {
                if (!token.isCancellationRequested) {
                    accept(line);
                }
            });
            lineReader.on('close', () => resolve());
        });
    }

    private getSearchArgs(options: FileSearchService.BaseOptions): string[] {
        const args = ['--files', '--hidden'];
        if (options.includePatterns) {
            for (const includePattern of options.includePatterns) {
                if (includePattern) {
                    args.push('--glob', includePattern);
                }
            }
        }
        if (options.excludePatterns) {
            for (const excludePattern of options.excludePatterns) {
                if (excludePattern) {
                    args.push('--glob', `!${excludePattern}`);
                }
            }
        }
        if (options.useGitIgnore) {
            // ripgrep follows `.gitignore` by default, but it doesn't exclude `.git`:
            args.push('--glob', '!.git');
        } else {
            args.push('--no-ignore');
        }
        return args;
    }

    private compareUris(a: string, b: string, pattern: string): number {

        /**
         * Normalize a given string.
         *
         * @param str the raw string value.
         * @returns the normalized string value.
         */
        function normalize(str: string): string {
            return str.trim().toLowerCase();
        }

        /**
         * Score a given string.
         *
         * @param str the string to score on.
         * @returns the score.
         */
        function score(str: string): number {
            const match = fuzzy.match(query, str);
            // eslint-disable-next-line no-null/no-null
            return (match === null) ? 0 : match.score;
        }

        // Normalize the user query.
        const query: string = normalize(pattern);

        // Score the item labels.
        const scoreA: number = score(a);
        const scoreB: number = score(b);

        // If both label scores are identical, perform additional computation.
        if (scoreA === scoreB) {

            // Favor the label which have the smallest substring index.
            const indexA: number = a.indexOf(query);
            const indexB: number = b.indexOf(query);

            if (indexA === indexB) {

                // Favor the result with the shortest label length.
                if (a.length !== b.length) {
                    return (a.length < b.length) ? -1 : 1;
                }

                // Fallback to the alphabetical order.
                const comparison = a.localeCompare(b);

                // If the alphabetical comparison is equal, call `compareItems` recursively using the `URI` member instead.
                if (comparison === 0) {
                    return this.compareUris(a, b, pattern);
                }

                return a.localeCompare(b);
            }

            return indexA - indexB;
        }

        return scoreB - scoreA;

    }

}
