export const MAX_ATTACHMENT_IMAGE_BYTES = 2 * 1024 * 1024;

const SUPPORTED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

type ImageAttachment = {
  name?: string;
  mime: string;
  size: number;
  dataUrl?: string;
  truncated?: boolean;
};

export type AccountRuntimeImage = {
  media_type: string;
  data: string;
};

export function isSupportedImageMime(mime: string): boolean {
  return SUPPORTED_IMAGE_MIMES.has(mime.toLowerCase());
}

export function assertValidImageAttachment(attachment: ImageAttachment): void {
  if (!attachment.mime.toLowerCase().startsWith("image/")) return;
  const label = attachment.name || "Image";
  if (!isSupportedImageMime(attachment.mime)) {
    throw new Error(`${label} must be PNG, JPEG, WebP, or GIF.`);
  }
  if (
    attachment.size <= 0 ||
    attachment.size > MAX_ATTACHMENT_IMAGE_BYTES ||
    attachment.truncated
  ) {
    throw new Error(`${label} must be no larger than 2 MB.`);
  }
  const prefix = `data:${attachment.mime.toLowerCase()};base64,`;
  if (!attachment.dataUrl?.toLowerCase().startsWith(prefix)) {
    throw new Error(`${label} could not be read as image data.`);
  }
}

export function accountRuntimeImage(
  attachment: ImageAttachment,
): AccountRuntimeImage | null {
  if (!attachment.mime.toLowerCase().startsWith("image/")) return null;
  assertValidImageAttachment(attachment);
  const separator = attachment.dataUrl!.indexOf(",");
  return {
    media_type: attachment.mime.toLowerCase(),
    data: attachment.dataUrl!.slice(separator + 1),
  };
}

export function readBrowserAttachmentDataUrl(
  file: File,
  mime: string,
): Promise<string | undefined> {
  if (!mime.toLowerCase().startsWith("image/")) return Promise.resolve(undefined);
  assertValidImageAttachment({
    name: file.name,
    mime,
    size: file.size,
    dataUrl: `data:${mime};base64,placeholder`,
  });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error(`${file.name || "Image"} could not be read as image data.`));
        return;
      }
      const separator = reader.result.indexOf(",");
      if (separator < 0) {
        reject(new Error(`${file.name || "Image"} could not be read as image data.`));
        return;
      }
      resolve(`data:${mime.toLowerCase()};base64,${reader.result.slice(separator + 1)}`);
    };
    reader.onerror = () =>
      reject(new Error(`${file.name || "Image"} could not be read as image data.`));
    reader.readAsDataURL(file);
  });
}
