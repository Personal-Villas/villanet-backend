import multer from 'multer';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES     = 2 * 1024 * 1024; // 2 MB

/**
 * memoryStorage: guarda el archivo en un Buffer (req.file.buffer)
 * en lugar de escribirlo a disco. Ideal para subirlo directamente a S3
 * sin archivos temporales en el servidor.
 */
const storage = multer.memoryStorage();

function fileFilter(_req, file, cb) {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPG, PNG and WEBP are allowed.'), false);
  }
}

export const uploadLogo = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_SIZE_BYTES },
}).single('agency_logo'); // "agency_logo" debe coincidir con el campo del FormData en el frontend