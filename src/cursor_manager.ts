import { NeovimClient } from "neovim";
import {
    Disposable,
    Range,
    Selection,
    TextEditor,
    TextEditorCursorStyle,
    TextEditorRevealType,
    TextEditorSelectionChangeEvent,
    TextEditorSelectionChangeKind,
    window,
} from "vscode";

import { BufferManager } from "./buffer_manager";
import { DocumentChangeManager } from "./document_change_manager";
import { Logger } from "./logger";
import { ModeManager } from "./mode_manager";
import { NeovimRedrawProcessable } from "./neovim_events_processable";
import { editorPositionToNeovimPosition, getNeovimCursorPosFromEditor } from "./utils";

const LOG_PREFIX = "CursorManager";

export interface CursorManagerSettings {
    mouseSelectionEnabled: boolean;
}

interface CursorInfo {
    cursorShape: "block" | "horizontal" | "vertical";
}

export class CursorManager implements Disposable, NeovimRedrawProcessable {
    private disposables: Disposable[] = [];
    /**
     * Vim cursor mode mappings
     */
    private cursorModes: Map<string, CursorInfo> = new Map();

    public constructor(
        private logger: Logger,
        private client: NeovimClient,
        private modeManager: ModeManager,
        private bufferManager: BufferManager,
        private changeManager: DocumentChangeManager,
        private settings: CursorManagerSettings,
    ) {
        this.disposables.push(window.onDidChangeTextEditorSelection(this.onSelectionChanged));
    }

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    public handleRedrawBatch(batch: [string, ...unknown[]][]): void {
        const winCursorsUpdates: Map<number, { line: number; col: number }> = new Map();
        for (const [name, ...args] of batch) {
            const firstArg = args[0] || [];
            switch (name) {
                case "win_viewport": {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    for (const [grid, win, topline, botline, curline, curcol] of args as number[][]) {
                        winCursorsUpdates.set(win, { line: curline, col: curcol });
                    }
                    break;
                }
                case "mode_info_set": {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const [, modes] = firstArg as [string, any[]];
                    for (const mode of modes) {
                        if (!mode.name || !mode.cursor_shape) {
                            continue;
                        }
                        this.cursorModes.set(mode.name, {
                            cursorShape: mode.cursor_shape,
                        });
                    }
                    break;
                }
                case "mode_change": {
                    const [newModeName] = firstArg as [string, never];
                    this.updateCursorStyle(newModeName);
                    break;
                }
            }
        }
        for (const [winId, cursorPos] of winCursorsUpdates) {
            this.logger.debug(
                `${LOG_PREFIX}: Received cursor update from neovim, winId: ${winId}, pos: [${cursorPos.line}, ${cursorPos.col}]`,
            );
            const editor = this.bufferManager.getEditorFromWinId(winId);
            if (!editor) {
                this.logger.warn(`${LOG_PREFIX}: No editor for winId: ${winId}`);
                continue;
            }
            // !For text changes neovim sends first buf_lines_event followed by redraw event
            // !But since changes are asynchronous and will happen after redraw event we need to wait for them first
            const queueUpdate = async (): Promise<void> => {
                await this.changeManager.getDocumentChangeCompletionLock(editor.document);
                this.updateCursorPosInEditor(editor, cursorPos.line, cursorPos.col);
            };
            queueUpdate();
        }
    }

    private onSelectionChanged = async (e: TextEditorSelectionChangeEvent): Promise<void> => {
        if (this.modeManager.isInsertMode) {
            return;
        }
        const { textEditor, kind, selections } = e;
        this.logger.debug(`${LOG_PREFIX}: SelectionChanged`);

        // wait for possible layout updates first
        this.logger.debug(`${LOG_PREFIX}: Waiting for possible layout completion operation`);
        await this.bufferManager.waitForLayoutSync();
        // wait for possible change document events
        this.logger.debug(`${LOG_PREFIX}: Waiting for possible document change completion operation`);
        await this.changeManager.getDocumentChangeCompletionLock(textEditor.document);

        const winId = this.bufferManager.getWinIdForTextEditor(textEditor);
        const cursor = selections[0].active;

        this.logger.debug(
            `${LOG_PREFIX}: kind: ${kind}, WinId: ${winId}, cursor: [${cursor.line}, ${
                cursor.character
            }], isMultiSelection: ${selections.length > 1}`,
        );
        if (!winId) {
            return;
        }

        if (e.selections.length > 1 || !e.selections[0].active.isEqual(e.selections[0].anchor)) {
            if (e.kind !== TextEditorSelectionChangeKind.Mouse || !this.settings.mouseSelectionEnabled) {
                return;
            } else {
                const grid = this.bufferManager.getGridIdForWinId(winId);
                this.logger.debug(`${LOG_PREFIX}: Processing multi-selection, gridId: ${grid}`);
                const requests: [string, unknown[]][] = [];
                if (!this.modeManager.isVisualMode && grid) {
                    // need to start visual mode from anchor char
                    const firstPos = e.selections[0].anchor;
                    const mouseClickPos = editorPositionToNeovimPosition(textEditor, firstPos);
                    this.logger.debug(
                        `${LOG_PREFIX}: Starting visual mode from: [${mouseClickPos[0]}, ${mouseClickPos[1]}]`,
                    );
                    requests.push([
                        "nvim_input_mouse",
                        // nvim_input_mouse is zero based while getNeovimCursorPosForEditor() returns 1 based line
                        ["left", "press", "", grid, mouseClickPos[0] - 1, mouseClickPos[1]],
                    ]);
                    requests.push(["nvim_input", ["v"]]);
                }
                const lastSelection = e.selections.slice(-1)[0];
                if (!lastSelection) {
                    return;
                }
                const cursorPos = editorPositionToNeovimPosition(e.textEditor, lastSelection.active);
                this.logger.debug(
                    `${LOG_PREFIX}: Updating cursor pos, winId: ${winId}, pos: [${cursorPos[0]}, ${cursorPos[1]}]`,
                );
                requests.push(["nvim_win_set_cursor", [winId, cursorPos]]);
                this.client.callAtomic(requests);
            }
        } else {
            const createJumpEntry =
                (!e.kind || e.kind === TextEditorSelectionChangeKind.Command) &&
                e.textEditor === window.activeTextEditor;

            const cursorPos = getNeovimCursorPosFromEditor(textEditor);
            this.logger.debug(
                `${LOG_PREFIX}: Updating cursor pos, winId: ${winId}, pos: [${cursorPos[0]}, ${cursorPos[1]}], createJumpEntry: ${createJumpEntry}`,
            );
            // const skipJump = this.skipJumpsForUris.get(e.textEditor.document.uri.toString());
            // if (skipJump) {
            //     createJumpEntry = false;
            //     this.skipJumpsForUris.delete(e.textEditor.document.uri.toString());
            // }
            const requests: [string, unknown[]][] = [["nvim_win_set_cursor", [winId, cursorPos]]];
            if (createJumpEntry) {
                requests.push(["nvim_call_function", ["VSCodeStoreJumpForWin", [winId]]]);
            }
            await this.client.callAtomic(requests);
        }
    };

    /**
     * Update cursor in active editor. Coords are zero based
     */
    private updateCursorPosInEditor = (editor: TextEditor, newLine: number, newCol: number): void => {
        this.logger.debug(
            `${LOG_PREFIX}: Updating cursor in editor, viewColumn: ${editor.viewColumn}, pos: [${newLine}, ${newCol}]`,
        );
        // if (this.leaveMultipleCursorsForVisualMode) {
        //     return;
        // }
        const visibleRange = editor.visibleRanges[0];
        const revealCursor = new Selection(newLine, newCol, newLine, newCol);
        // if (!this.neovimCursorUpdates.has(editor)) {
        //     this.neovimCursorUpdates.set(editor, {});
        // }
        // this.neovimCursorUpdates.get(editor)![`${newLine}.${newCol}`] = true;
        editor.selections = [revealCursor];
        const visibleLines = visibleRange.end.line - visibleRange.start.line;
        // this.commitScrolling.cancel();
        if (visibleRange.contains(revealCursor)) {
            // always try to reveal even if in visible range to reveal horizontal scroll
            editor.revealRange(new Range(revealCursor.active, revealCursor.active), TextEditorRevealType.Default);
        } else if (revealCursor.active.line < visibleRange.start.line) {
            const revealType =
                visibleRange.start.line - revealCursor.active.line >= visibleLines / 2
                    ? TextEditorRevealType.Default
                    : TextEditorRevealType.AtTop;
            // this.textEditorsRevealing.set(editor, revealCursor.active.line);
            editor.revealRange(new Range(revealCursor.active, revealCursor.active), revealType);
            // vscode.commands.executeCommand("revealLine", { lineNumber: revealCursor.active.line, at: revealType });
        } else if (revealCursor.active.line > visibleRange.end.line) {
            const revealType =
                revealCursor.active.line - visibleRange.end.line >= visibleLines / 2
                    ? TextEditorRevealType.InCenter
                    : TextEditorRevealType.Default;
            // this.textEditorsRevealing.set(editor, revealCursor.active.line);
            editor.revealRange(new Range(revealCursor.active, revealCursor.active), revealType);
            // vscode.commands.executeCommand("revealLine", { lineNumber: revealCursor.active.line, at: revealType });
        }
    };

    private updateCursorStyle(modeName: string): void {
        const modeConf = this.cursorModes.get(modeName);
        if (!modeConf) {
            return;
        }
        for (const editor of window.visibleTextEditors) {
            if (modeConf.cursorShape === "block") {
                editor.options.cursorStyle = TextEditorCursorStyle.Block;
            } else if (modeConf.cursorShape === "horizontal") {
                editor.options.cursorStyle = TextEditorCursorStyle.Underline;
            } else {
                editor.options.cursorStyle = TextEditorCursorStyle.Line;
            }
        }
    }
}
