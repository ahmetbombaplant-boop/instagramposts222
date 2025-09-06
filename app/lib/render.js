// app/lib/render.js
const axios = require('axios');
const cloudinary = require('cloudinary').v2;

let cloudinaryReady = true;
try {
  cloudinary.config(true); // читает CLOUDINARY_URL
} catch (e) {
  cloudinaryReady = false;
  console.log('[cloudinary] disabled:', e.message);
}

/**
 * Минимальный рендер: скачиваем и заливаем в Cloudinary (resize/cloud можно скрутить позже).
 * Возвращаем массив secure_url.
 */
async function renderFinalSlides(selected) {
  if (!cloudinaryReady) throw new Error('Cloudinary not configured');
  const out = [];
  for (let i = 0; i < selected.length; i++) {
    const s = selected[i];
    // Загружаем прямо по URL — Cloudinary сам скачает и сохранит
    const r = await cloudinary.uploader.upload(s.url, {
      folder: 'sigma-pack',
      public_id: `slide_${Date.now()}_${i + 1}`,
      overwrite: true,
      transformation: [
        { width: 1080, height: 1350, crop: "fill", gravity: "auto" },
        { effect: "saturation:-20" }
      ]
    });
    out.push(r.secure_url);
  }
  return out;
}

async function genCaption(selected) {
  // базовая подпись — потом заменим на умную
  return [
    'По делу. Без позы.',
    'Суть важнее формы.',
    '#discipline #focus #sigma'
  ].join('\n');
}

module.exports = { renderFinalSlides, genCaption };
