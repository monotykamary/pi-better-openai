// Terminal focus tracking via private mode 1004 (xterm focus-event reporting).
// Enabling `CSI ? 1004 h` makes the terminal emit `CSI I` on focus-in and
// `CSI O` on focus-out as input sequences; pi-tui's stdin buffer frames them
// as generic CSI and forwards them to input listeners unmodified, so an
// extension can observe them without any upstream keymap changes. Support is
// detected with a DECRQM probe (`CSI ? 1004 $ p` -> `CSI ? 1004 ; 1 $ y` set /
// `; 2 $ y` reset); terminals that ignore both sequences simply fall back to
// the FIFO floor policy. Supported by iTerm2, kitty, WezTerm, Alacritty, foot,
// Windows Terminal, xterm.js, and modern tmux.

export const FOCUS_REPORTING_ENABLE = "\x1b[?1004h";
export const FOCUS_REPORTING_DISABLE = "\x1b[?1004l";
export const FOCUS_IN_SEQUENCE = "\x1b[I";
export const FOCUS_OUT_SEQUENCE = "\x1b[O";
export const DECRQM_FOCUS_QUERY = "\x1b[?1004$p";

export type FocusInputListener = (data: string) => { consume?: boolean; data?: string } | undefined;

export interface FocusTerminalHandle {
  write(data: string): void;
  addInputListener(listener: FocusInputListener): () => void;
}

export function parseFocusSequence(data: string): boolean | undefined {
  if (data === FOCUS_IN_SEQUENCE) return true;
  if (data === FOCUS_OUT_SEQUENCE) return false;
  return undefined;
}

export function parseDecrqmFocusResponse(data: string): boolean | undefined {
  if (data === "\x1b[?1004;1$y" || data === "\x1b[?1004;3$y") return true;
  if (data === "\x1b[?1004;2$y" || data === "\x1b[?1004;4$y") return false;
  return undefined;
}

export function probeFocusReporting(
  handle: FocusTerminalHandle,
  timeoutMs = 400,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let removeListener: (() => void) | undefined;
    const done = (supported: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeListener?.();
      resolve(supported);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    try {
      removeListener = handle.addInputListener((data) => {
        const state = parseDecrqmFocusResponse(data);
        if (state === undefined) return undefined;
        done(true);
        return { consume: true };
      });
      handle.write(DECRQM_FOCUS_QUERY);
    } catch {
      done(false);
    }
  });
}

export function attachFocusReporting(
  handle: FocusTerminalHandle,
  onFocus: (focused: boolean) => void,
): () => void {
  const removeListener = handle.addInputListener((data) => {
    const focused = parseFocusSequence(data);
    if (focused === undefined) return undefined;
    onFocus(focused);
    return { consume: true };
  });
  try {
    handle.write(FOCUS_REPORTING_ENABLE);
  } catch {
    // The terminal write path is best-effort; focus events simply never arrive.
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    removeListener();
    try {
      handle.write(FOCUS_REPORTING_DISABLE);
    } catch {
      // Nothing to undo on a torn-down tty.
    }
  };
}
