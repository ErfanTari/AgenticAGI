const request = require('supertest');
const app = require('./server');

describe('Express Server', () => {
  describe('GET /ok', () => {
    it('should return {"ok": true}', async () => {
      const response = await request(app).get('/ok');
      
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
    });
  });
});