/**
 * Permite ejecutar los archivos de api/ tal cual estan, con sus imports ".js".
 * Vercel resuelve esa convencion al compilar; aqui la resolvemos en caliente
 * para poder probar el handler real en vez de una copia.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./resolver-hook.mjs', pathToFileURL('./tests/emulator/'));
