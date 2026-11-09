let guard: (() => boolean) | undefined;

/** Registers a synchronous leave check; return true to allow leaving and false to cancel. */
export function registerTerminalDraftGuard(callback: () => boolean): () => void {
  const registration = () => callback();
  guard = registration;
  return () => {
    if (guard === registration) guard = undefined;
  };
}

/** Returns false if the registered guard cancels or throws. */
export function canLeaveTerminalDrafts(): boolean {
  try {
    return guard?.() ?? true;
  } catch {
    return false;
  }
}
