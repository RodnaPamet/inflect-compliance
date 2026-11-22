const { execSync } = require('child_process');
const url = 'postgresql://postgres:postgres@127.0.0.1:5433/inflect_compliance?schema=public&pgbouncer=true';
try {
  execSync(
    `node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({datasources:{db:{url:'${url.replace(/'/g, "\\\\'")}'}}});p.\\$connect().then(()=>p.\\$queryRaw\\\`SELECT 1\\\`).then(()=>{p.\\$disconnect();process.exit(0)}).catch(()=>{p.\\$disconnect().catch(()=>{});process.exit(1)})"`,
    { timeout: 5000, stdio: 'inherit', cwd: process.cwd() },
  );
  console.log('DB_AVAILABLE: true');
} catch(e) {
  console.log('DB_AVAILABLE: false');
  // Try direct URL
  const directUrl = 'postgresql://postgres:postgres@127.0.0.1:5436/inflect_compliance?schema=public';
  try {
    execSync(
      `node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({datasources:{db:{url:'${directUrl}'}}});p.\\$connect().then(()=>p.\\$queryRaw\\\`SELECT 1\\\`).then(()=>{p.\\$disconnect();process.exit(0)}).catch(()=>{p.\\$disconnect().catch(()=>{});process.exit(1)})"`,
      { timeout: 5000, stdio: 'inherit', cwd: process.cwd() },
    );
    console.log('DIRECT DB_AVAILABLE: true');
  } catch(e2) {
    console.log('DIRECT DB_AVAILABLE: false');
  }
}
