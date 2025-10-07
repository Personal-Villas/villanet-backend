import jwt from 'jsonwebtoken';

export function auth(required = true) {
  return (req, res, next) => {
    const hdr = req.headers.authorization;
    const token = hdr && hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (!token) return required ? res.status(401).json({ message: 'No token' }) : next();

    try {
      const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
      req.user = payload; // { sub, role, status }
      next();
    } catch (e) {
      return res.status(401).json({ message: 'Invalid token' });
    }
  };
}
