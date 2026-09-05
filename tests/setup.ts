import { config } from 'dotenv'

// Os testes de RLS precisam das credenciais reais do projeto Supabase.
// Os de parser e anonimizador nao precisam de nada.
config({ path: '.env.local', quiet: true })
