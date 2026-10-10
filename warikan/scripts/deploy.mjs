// Cloudflare へのデプロイ（GitHub Actions から実行）。
// D1 データベースと Pages プロジェクトがなければ作ってから、public/ と functions/ を公開する。
// 必要な環境変数: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const PROJECT = process.env.PAGES_PROJECT || 'warikan';
const DATABASE = process.env.D1_DATABASE || 'warikan';
const BRANCH = process.env.DEPLOY_BRANCH || 'main';
const COMPATIBILITY_DATE = '2026-09-01';

for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
  if (!process.env[name]) {
    console.error(`::error::GitHub のリポジトリ設定 → Secrets and variables → Actions に ${name} を登録してください（README の「デプロイの設定」参照）`);
    process.exit(1);
  }
}

function wrangler(args, { json = false } = {}) {
  const out = execFileSync('npx', ['wrangler', ...args, ...(json ? ['--json'] : [])], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (!json) {
    process.stdout.write(out);
    return out;
  }
  // 先頭にバナーなどが付くことがあるので、JSON の部分だけ取り出す
  return JSON.parse(out.slice(out.search(/[\[{]/)));
}

// 1. D1 データベース
let db = wrangler(['d1', 'list'], { json: true }).find((d) => d.name === DATABASE);
if (!db) {
  console.log(`D1 データベース「${DATABASE}」を作成します`);
  wrangler(['d1', 'create', DATABASE, '--location', 'apac']);
  db = wrangler(['d1', 'list'], { json: true }).find((d) => d.name === DATABASE);
}
console.log(`D1: ${db.name} (${db.uuid})`);

// 2. Pages プロジェクト
const projects = wrangler(['pages', 'project', 'list'], { json: true });
if (!projects.some((p) => (p.name || p['Project Name']) === PROJECT)) {
  console.log(`Pages プロジェクト「${PROJECT}」を作成します`);
  wrangler(['pages', 'project', 'create', PROJECT, '--production-branch', BRANCH, '--compatibility-date', COMPATIBILITY_DATE]);
}

// 3. 設定ファイル（D1 のつなぎ込み）を書いて公開
writeFileSync('wrangler.toml', `# scripts/deploy.mjs が自動で作るファイル（コミットしない）
name = "${PROJECT}"
pages_build_output_dir = "public"
compatibility_date = "${COMPATIBILITY_DATE}"

[[d1_databases]]
binding = "DB"
database_name = "${db.name}"
database_id = "${db.uuid}"
`);
wrangler(['pages', 'deploy', '--branch', BRANCH, '--commit-dirty=true']);
