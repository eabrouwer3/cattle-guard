/**
 * At document_start the parser may not have created <html> yet, so anything
 * that needs to attach to the document has to wait for it.
 */
export function whenRootReady(): Promise<HTMLElement> {
  if (document.documentElement) return Promise.resolve(document.documentElement);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (document.documentElement) {
        observer.disconnect();
        resolve(document.documentElement);
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
}
