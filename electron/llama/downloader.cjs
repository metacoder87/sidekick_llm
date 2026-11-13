'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function isCancellation(error) {
  return Boolean(error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
}

// Download `url` to `destPath` with resume support, for the built-in model
// gallery (HuggingFace GGUF files).
//
// Guarantees:
//  - The file is written to `destPath + '.part'` and only renamed to
//    `destPath` after a complete transfer, so a half-finished download can
//    never be mistaken for a usable model.
//  - An existing `.part` file is resumed with an HTTP Range request. A server
//    that answers 200 (range ignored) restarts the file; a 416 (range beyond
//    EOF, e.g. the file already completed server-side) restarts it as well.
//  - Cancellation never throws: it returns { ok:false, cancelled:true }.
//
// `fetchImpl` is injectable so the transfer logic can be tested deterministically.
async function downloadFile({
  url,
  destPath,
  signal,
  onProgress = () => {},
  fetchImpl = fetch,
} = {}) {
  if (!url) return { ok: false, reason: 'No download URL.' };
  if (!destPath) return { ok: false, reason: 'No destination path.' };

  const partPath = `${destPath}.part`;
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  let resumeFrom = 0;
  try {
    resumeFrom = (await fs.stat(partPath)).size;
  } catch (_error) {
    resumeFrom = 0;
  }

  const attempt = async (fromByte) => {
    const headers = {};
    if (fromByte > 0) headers.Range = `bytes=${fromByte}-`;

    const response = await fetchImpl(url, { headers, signal, redirect: 'follow' });
    if (response.status === 416) {
      // Our offset is past the end of the remote file — start clean.
      await fs.rm(partPath, { force: true });
      return attempt(0);
    }
    if (!response.ok && response.status !== 206) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }
    if (response.status === 200) {
      // Server does not honour Range — restart from scratch.
      await fs.rm(partPath, { force: true });
    }
    return response;
  };

  let response;
  try {
    response = await attempt(resumeFrom);
  } catch (error) {
    if (isCancellation(error)) return { ok: false, cancelled: true, reason: 'Download cancelled.' };
    return { ok: false, reason: error.message };
  }

  if (response.status === 200) resumeFrom = 0;
  const contentLength = Number(response.headers?.get?.('content-length')) || 0;
  const total =
    contentLength > 0
      ? resumeFrom + (response.status === 206 ? contentLength : contentLength)
      : null;
  // For a 200 restart the content-length IS the whole file.
  const knownTotal = response.status === 200 ? contentLength || null : total;

  const report = (completed, status) => {
    onProgress({
      status,
      total: knownTotal,
      completed,
      percent:
        knownTotal && completed > 0
          ? Math.min(100, Math.round((completed / knownTotal) * 100))
          : null,
    });
  };

  try {
    if (!response.body) {
      // Non-streaming body (test stubs, some fetch implementations).
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(partPath, buffer);
      report(buffer.byteLength, 'downloaded');
      await fs.rename(partPath, destPath);
      return { ok: true, name: path.basename(destPath), total: buffer.byteLength };
    }

    const handle = await fs.open(partPath, resumeFrom > 0 ? 'a' : 'w');
    let completed = resumeFrom;
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        await handle.write(value);
        completed += value.byteLength;
        report(completed, 'downloading');
      }
    } finally {
      await handle.close().catch(() => {});
    }

    // A zero-byte "model" is useless — never rename an empty file into place.
    const stat = await fs.stat(partPath);
    if (stat.size === 0) {
      await fs.rm(partPath, { force: true });
      return { ok: false, reason: 'Download finished empty. Check the connection and try again.' };
    }

    report(stat.size, 'complete');
    await fs.rename(partPath, destPath);
    return { ok: true, name: path.basename(destPath), total: stat.size };
  } catch (error) {
    if (isCancellation(error)) {
      return { ok: false, cancelled: true, reason: 'Download cancelled.' };
    }
    return { ok: false, reason: error.message };
  }
}

module.exports = { downloadFile };
