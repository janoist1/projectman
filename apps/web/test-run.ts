import { MockBackend } from './src/mocks/backend';
const backend = new MockBackend();
const created = backend.handle('POST', '/api/projects/AC/tasks', { title: 'T1' });
console.log(created.body);
