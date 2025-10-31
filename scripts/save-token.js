import { pool } from '../src/db.js';

const TOKEN = 'eyJraWQiOiJoZ0xIZGJtNDllTFRULTFUemVkY05nMlAwYUk3ZWdGd0VoOHluTDQtMEVjIiwiYWxnIjoiUlMyNTYifQ.eyJ2ZXIiOjEsImp0aSI6IkFULkVJS0kyNVZHYjl0cmx3alVkVzFmZkljS0hYTTNYYnV2cXdXOGk1dVVydXMiLCJpc3MiOiJodHRwczovL2xvZ2luLmd1ZXN0eS5jb20vb2F1dGgyL2F1czFwOHFyaDUzQ2NRVEk5NWQ3IiwiYXVkIjoiaHR0cHM6Ly9vcGVuLWFwaS5ndWVzdHkuY29tIiwiaWF0IjoxNzYxOTA4ODIyLCJleHAiOjE3NjE5OTUyMjIsImNpZCI6IjBvYXI5Y2pndWV1M2dMUUZsNWQ3Iiwic2NwIjpbIm9wZW4tYXBpIl0sInJlcXVlc3RlciI6IkVYVEVSTkFMIiwiYWNjb3VudElkIjoiNjM0ODdiYjU4MmFmZDUwMDMzOTVlMzQwIiwic3ViIjoiMG9hcjljamd1ZXUzZ0xRRmw1ZDciLCJ1c2VyUm9sZXMiOlt7InJvbGVJZCI6eyJwZXJtaXNzaW9ucyI6WyJhZG1pbiJdfX1dLCJyb2xlIjoidXNlciIsImNsaWVudFR5cGUiOiJvcGVuYXBpIiwiaWFtIjoidjMiLCJhY2NvdW50TmFtZSI6IlBlcnNvbmFsIFZpbGxhcyIsIm5hbWUiOiJ2aWxsYW5ldCJ9.C5xrgsCqEUm47IHg3JA2KalZW8i-Ojs7zu6SLpy9XazbbeR0kYNoAn7VRaX5r2e7cj7DgaVP3eq_oXxcGlkfVr4yBpxPmyyPz6CwE6n2XpSXOYWFzZx94sC_7gqEPscDPecMYO5WQqvZIKbC3rIEqyau7IZJIQjM0WkYh2Ioro8BFGlFwZ8gyQA-jnBBtPvSM_N4NsDRggG9JhIUcvXeEftqobmgq9UfRlRkXfXEnmclrXhJ4_Vr58rEytYASMIAqrVckl_u9r7ry9s_RDGvU8Gyy1GGZa3S3Vq_CHN25D_6CuOnPFtX3G0kq4QWiq_kvuKqWxGrtA91aw66bIPb_A';

// Del payload JWT: "exp":1761995222 (timestamp en segundos)
const EXPIRES_AT = 1761995222 * 1000; // Convertir a milisegundos

async function saveToken() {
  try {
    await pool.query(`
      INSERT INTO settings(key, value) 
      VALUES('GUESTY_OAUTH_TOKEN', $1)
      ON CONFLICT(key) DO UPDATE 
      SET value=excluded.value, updated_at=now()
    `, [TOKEN]);

    await pool.query(`
      INSERT INTO settings(key, value) 
      VALUES('GUESTY_OAUTH_EXPIRES_AT', $1)
      ON CONFLICT(key) DO UPDATE 
      SET value=excluded.value, updated_at=now()
    `, [String(EXPIRES_AT)]);

    console.log('✅ Token saved successfully');
    console.log('Token preview:', TOKEN.substring(0, 30) + '...');
    console.log('Expires at:', new Date(EXPIRES_AT).toISOString());
    console.log('Valid for:', Math.round((EXPIRES_AT - Date.now()) / 1000 / 60 / 60), 'hours');
    
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    await pool.end();
    process.exit(1);
  }
}

saveToken();