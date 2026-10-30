/** Extracts `{ error }` from a failed API response, falling back to the HTTP status. */
export async function apiErrorMessage(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  return `Request failed (HTTP ${res.status})`;
}
