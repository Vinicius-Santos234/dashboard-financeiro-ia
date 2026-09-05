/**
 * Stub de `server-only` para os testes.
 *
 * O pacote real lanca erro quando importado fora de um Server Component. Essa
 * guarda existe para o BUNDLER do Next: ela impede que um modulo de servidor
 * vaze para o bundle do cliente. O Vitest nao e o bundler do Next, entao a
 * guarda nao tem o que proteger aqui — so impediria testar o repositorio.
 *
 * Isto NAO enfraquece a protecao em producao: o `next build` continua usando o
 * pacote de verdade, e um import indevido em Client Component continua
 * quebrando o build.
 */
export {}
