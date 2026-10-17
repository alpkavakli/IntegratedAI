// @ts-check
/**
 * Turn an inspection result into text for the model, taking out an image
 * (screenshot: { image: { mediaType, data } }; watch_video: images: [...] and audio) so they can be sent as
 * image and audio blocks.
 * Shared by the orchestrator (all providers) and the server's MCP page tools.
 */

const MAX_RESULT_CHARS = 30_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
const MAX_IMAGE_BASE64 = 5 * 1024 * 1024; // the Anthropic API's limit per image
const MAX_IMAGES = 4;
const MAX_AUDIO_BASE64 = 4 * 1024 * 1024; // a minute of 16 kHz mono WAV is about 2.6 MB in base64
const isBase64 = (/** @type {unknown} */ s) => typeof s === 'string' && /^[A-Za-z0-9+/]+=*$/.test(s);
const validImage = (/** @type {any} */ image) => IMAGE_TYPES.has(image?.mediaType) && isBase64(image.data) && image.data.length <= MAX_IMAGE_BASE64;

/** @typedef {{ mediaType: string, data: string }} ToolImage */

/**
 * @param {unknown} result
 * @returns {{ text: string, images?: ToolImage[], audio?: ToolImage }}
 */
export function formatResult(result) {
  /** @type {any} */
  let data = result ?? null;
  /** @type {ToolImage[]} */
  const images = [];
  if (data && typeof data === 'object' && data.image) {
    const { image, ...rest } = data;
    data = rest;
    if (validImage(image)) {
      images.push({ mediaType: image.mediaType, data: image.data });
      data.image = 'attached';
    } else {
      data.image = 'missing (invalid or too large)';
    }
  }
  if (data && typeof data === 'object' && Array.isArray(data.images)) {
    const { images: list, ...rest } = data;
    data = rest;
    const valid = list.filter(validImage).slice(0, MAX_IMAGES);
    images.push(...valid.map((/** @type {any} */ i) => ({ mediaType: i.mediaType, data: i.data })));
    data.images = valid.length === list.length ? `${valid.length} attached` : `${valid.length} of ${list.length} attached (the rest invalid or too many)`;
  }
  /** @type {ToolImage | undefined} */
  let audio;
  if (data && typeof data === 'object' && data.audio) {
    const { audio: sound, ...rest } = data;
    data = rest;
    if (sound?.mediaType === 'audio/wav' && isBase64(sound.data) && sound.data.length <= MAX_AUDIO_BASE64) audio = { mediaType: sound.mediaType, data: sound.data };
    else data.audio = 'missing (invalid or too long)';
  }
  const text = JSON.stringify(data);
  return {
    text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… [truncated]` : text,
    ...(images.length ? { images } : {}),
    ...(audio ? { audio } : {}),
  };
}
