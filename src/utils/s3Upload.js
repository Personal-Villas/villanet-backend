import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import path from 'path';

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET_NAME;

/**
 * Sube un archivo a S3 y devuelve su URL pública.
 *
 * @param {Buffer} buffer      - Contenido del archivo en memoria (viene de multer memoryStorage)
 * @param {string} originalName - Nombre original del archivo (para extraer la extensión)
 * @param {string} folder      - Carpeta dentro del bucket (ej: 'imagenes-logos-villanet')
 * @returns {Promise<string>}  - URL pública del archivo subido
 */
export async function uploadToS3(buffer, originalName, folder = 'imagenes-logos-villanet') {
  const ext  = path.extname(originalName).toLowerCase(); // .jpg, .png, .webp
  const key  = `${folder}/${randomUUID()}${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: mimeFromExt(ext),
  }));

  // URL pública — requiere que el bucket tenga Block Public Access desactivado
  // y una bucket policy que permita s3:GetObject a "*".
  // Si el bucket es privado, reemplazar por una Presigned URL (ver comentario abajo).
  return `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

  /*
   * Alternativa con URL firmada (bucket privado):
   *
   * import { GetObjectCommand } from '@aws-sdk/client-s3';
   * import { getSignedUrl }     from '@aws-sdk/s3-request-presigner';
   *
   * const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
   * return url;
   */
}

/**
 * Elimina un objeto de S3 a partir de su URL pública.
 * Se usa cuando el usuario reemplaza su logo por uno nuevo.
 *
 * @param {string} publicUrl - URL pública del archivo a eliminar
 */
export async function deleteFromS3ByUrl(publicUrl) {
  try {
    // Extraer la key del path de la URL: todo lo que viene después del dominio
    const url = new URL(publicUrl);
    const key = url.pathname.replace(/^\//, ''); // quitar el "/" inicial

    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    // No lanzar — si falla el borrado del archivo viejo no debe interrumpir el flujo
    console.warn('⚠️  Could not delete old S3 object:', err.message);
  }
}

function mimeFromExt(ext) {
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  return map[ext] || 'application/octet-stream';
}