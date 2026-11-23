// Starts the server in mock mode: no API key needed, photos return sample waybills.
process.env.MOCK_EXTRACTION = '1';
await import('../server.js');
