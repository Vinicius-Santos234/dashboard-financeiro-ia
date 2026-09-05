import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js externaliza firebase-admin por padrão. Com a versão 14, isso deixa o
  // jwks-rsa (CommonJS) tentar carregar jose (ESM) via require() na Vercel.
  // Empacotar o SDK permite ao Turbopack resolver corretamente essa fronteira.
  transpilePackages: ["firebase-admin"],
};

export default nextConfig;
