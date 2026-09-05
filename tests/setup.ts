import { config } from 'dotenv'

// Os testes de Security Rules precisam das credenciais reais do Firebase.
// Os de parser e anonimizador nao precisam de nada.
config({ path: '.env.local', quiet: true })
