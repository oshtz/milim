export const MAX_DESKTOP_REQUEST_BODY_BYTES = 30 * 1024 * 1024;

export function assertDesktopRequestBodyFits(body: BodyInit | null | undefined) {
  if (
    typeof body === "string" &&
    new TextEncoder().encode(body).byteLength > MAX_DESKTOP_REQUEST_BODY_BYTES
  ) {
    throw new Error(
      "This request is too large to send. Remove some images or compact/start a new chat, then retry.",
    );
  }
}
