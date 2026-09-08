import { createServer } from 'node:net';
export async function ensurePortAvailable(port, host = '127.0.0.1') {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Porta inválida. Use um número entre 1 e 65535.');
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => reject(new Error(error.code === 'EADDRINUSE' ? `A porta ${port} já está em uso. Encerre a execução anterior com Ctrl+C ou configure outra porta.` : `Não foi possível abrir a porta ${port}: ${error.code}`)));
    server.listen(port, host, () => server.close(resolve));
  });
}
