/** Releases a response body we are not going to read. */
export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection may already be closed.
  }
}
