// アプリの設定。変えたいときはここを書き換えて、GitHub にプッシュする（Cloudflare Pages が自動で再公開する）

// 割り勘のメンバーと負担の割合（てん 2 : あおい 1）
export const MEMBERS = [
  { name: 'てん', share: 2 },
  { name: 'あおい', share: 1 },
];

// 「何の費用？」の選択肢
export const CATEGORIES = ['食べ物', '日用品', '電気ガス水道家賃', '薬', '娯楽'];

// 毎月自動で入れる固定費（その月を最初に開いたときに 1 回だけ追加される。消せば追加し直されない）
export const RECURRING = [
  { amount: 80440, payer: 'てん', category: '電気ガス水道家賃', comment: '家賃' },
];

// ログインしたままにする期間（日）
export const SESSION_DAYS = 365;
