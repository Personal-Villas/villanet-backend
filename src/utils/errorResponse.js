/**
 * errorResponse.js
 * 
 * Helpers para respuestas de error estandarizadas del backend.
 * Formato unificado:
 * {
 *   success: false,
 *   message: "Mensaje legible para el usuario",
 *   code: "ERROR_CODE_SEMANTICO",      // para que el frontend pueda actuar específicamente
 *   details: "..."                      // solo en development
 * }
 */

/**
 * Error crítico: la operación principal NO se completó.
 * El frontend puede reintentar sin riesgo.
 */
export function criticalError(res, { status = 500, message, code, details } = {}) {
  const body = {
    success: false,
    message: message || 'An unexpected error occurred. Please try again.',
    code: code || 'INTERNAL_ERROR',
  };

  if (process.env.NODE_ENV === 'development' && details) {
    body.details = details;
  }

  return res.status(status).json(body);
}

/**
 * Error parcial: la operación principal SÍ se completó, pero algo secundario falló.
 * El frontend NO debe reintentar la operación completa (evitar duplicados).
 */
export function partialError(res, { message, code, data } = {}) {
  return res.status(207).json({  // 207 Multi-Status
    success: true,               // el recurso principal se creó
    partial: true,               // pero algo falló
    message: message || 'Operation completed with warnings.',
    code: code || 'PARTIAL_SUCCESS',
    data,
  });
}

/**
 * Error de validación (4xx)
 */
export function validationError(res, { message, code, fields } = {}) {
  const body = {
    success: false,
    message: message || 'Please check the required fields and try again.',
    code: code || 'VALIDATION_ERROR',
  };

  if (fields) body.fields = fields;

  return res.status(400).json(body);
}

/**
 * No encontrado (404)
 */
export function notFoundError(res, { message, code } = {}) {
  return res.status(404).json({
    success: false,
    message: message || 'The requested resource was not found.',
    code: code || 'NOT_FOUND',
  });
}