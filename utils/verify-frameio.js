'use strict';

const crypto = require('crypto');

function verifyFrameioSignature(rawBody, signature) {
  const secret = process.env.FRAMEIO_WEBHOOK_SECRET;
  if (!secret || !signature) return false;

  try {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const digest = hmac.digest('hex');

    const sigValue = signature.trim().replace(/^sha256=/, '');

    if (sigValue.length !== digest.length) return false;

    return crypto.timingSafeEqual(
      Buffer.from(sigValue, 'utf8'),
      Buffer.from(digest, 'utf8')
    );
  } catch {
    return false;
  }
}

module.exports = { verifyFrameioSignature };
