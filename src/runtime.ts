// Timer helper shared by the plugin (Obsidian's renderer, where popout
// windows require that window's own setTimeout) and the Node scripts/tests
// (where `window` doesn't exist).
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const setTimer: (callback: () => void, delay: number) => unknown =
      typeof window !== "undefined"
        ? window.setTimeout.bind(window)
        : setTimeout;
    setTimer(resolve, ms);
  });
}
