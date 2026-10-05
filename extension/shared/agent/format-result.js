// @ts-check
/**
 * Turn an inspection result into text for the model, taking out an image
 * (screenshot: { image: { mediaType, data } }) so it can be sent as an image block.
 * Shared by the orchestrator (all providers) and the server's MCP page tools.
 */

const MAX_RESULT_CHARS = 30_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
const MAX_IMAGE_BASE64 = 5 * 1024 * 1024; // the Anthropic API's limit per image

/** @typedef {{ mediaType: string, data: string }} ToolImage */

/**
 * @param {unknown} result
 * @returns {{ text: string, images?: ToolImage[] }}
 */
export function formatResult(result) {
  /** @type {any} */
  let data = result ?? null;
  /** @type {ToolImage[]} */
  const images = [];
  if (data && typeof data === 'object' && data.image) {
    const { image, ...rest } = data;
    data = rest;
    if (IMAGE_TYPES.has(image?.mediaType) && typeof image.data === 'string' && image.data.length <= MAX_IMAGE_BASE64
      && /^[A-Za-z0-9+/]+=*$/.test(image.data)) {
      images.push({ mediaType: image.mediaType, data: image.data });
      data.image = 'attached';
    } else {
      data.image = 'missing (invalid or too large)';
    }
  }
  const text = JSON.stringify(data);
  return {
    text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… [truncated]` : text,
    ...(images.length ? { images } : {}),
  };
}
