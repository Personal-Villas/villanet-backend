import axios from 'axios';

export const guesty = axios.create({
    baseURL: 'https://open-api.guesty.com',
    timeout: 15000,
});

guesty.interceptors.request.use(cfg => {
  cfg.headers.Authorization = `Bearer ${process.env.GUESTY_TOKEN}`;
  return cfg;
});