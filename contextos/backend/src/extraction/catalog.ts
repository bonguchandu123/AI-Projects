/** Known technologies → decision subject. Used by the fallback extractor and query routing. */
export interface CatalogEntry {
  name: string;
  subject: string | null;
  patterns: RegExp[];
}

const ci = (s: string) => new RegExp(`(?<![A-Za-z0-9])${s.replace(/\./g, "\\.")}(?![A-Za-z0-9])`, "i");
const cs = (s: string) => new RegExp(`(?<![A-Za-z0-9])${s.replace(/\./g, "\\.")}(?![A-Za-z0-9])`);

export const CATALOG: CatalogEntry[] = [
  { name: "PostgreSQL", subject: "database", patterns: [ci("postgresql"), ci("postgres")] },
  { name: "MongoDB", subject: "database", patterns: [ci("mongodb"), ci("mongo")] },
  { name: "MySQL", subject: "database", patterns: [ci("mysql")] },
  { name: "SQLite", subject: "database", patterns: [ci("sqlite")] },
  { name: "MariaDB", subject: "database", patterns: [ci("mariadb")] },
  { name: "DynamoDB", subject: "database", patterns: [ci("dynamodb")] },
  { name: "Firestore", subject: "database", patterns: [ci("firestore")] },
  { name: "Supabase", subject: "database", patterns: [ci("supabase")] },
  { name: "Redis", subject: "cache", patterns: [ci("redis")] },
  { name: "Memcached", subject: "cache", patterns: [ci("memcached")] },
  { name: "Heroku", subject: "hosting", patterns: [ci("heroku")] },
  { name: "Render", subject: "hosting", patterns: [cs("Render")] },
  { name: "Vercel", subject: "hosting", patterns: [ci("vercel")] },
  { name: "Netlify", subject: "hosting", patterns: [ci("netlify")] },
  { name: "AWS", subject: "hosting", patterns: [cs("AWS"), ci("amazon web services")] },
  { name: "Fly.io", subject: "hosting", patterns: [ci("fly.io")] },
  { name: "Railway", subject: "hosting", patterns: [cs("Railway")] },
  { name: "Stripe", subject: "payments", patterns: [ci("stripe")] },
  { name: "PayPal", subject: "payments", patterns: [ci("paypal")] },
  { name: "Razorpay", subject: "payments", patterns: [ci("razorpay")] },
  { name: "GraphQL", subject: "api_style", patterns: [ci("graphql")] },
  { name: "gRPC", subject: "api_style", patterns: [ci("grpc")] },
  { name: "Next.js", subject: "frontend_framework", patterns: [ci("next.js"), ci("nextjs")] },
  { name: "React", subject: "frontend_framework", patterns: [cs("React")] },
  { name: "Vue", subject: "frontend_framework", patterns: [cs("Vue"), ci("vue.js")] },
  { name: "Angular", subject: "frontend_framework", patterns: [cs("Angular")] },
  { name: "Svelte", subject: "frontend_framework", patterns: [ci("svelte")] },
  { name: "Express", subject: "backend_framework", patterns: [cs("Express"), ci("express.js")] },
  { name: "Fastify", subject: "backend_framework", patterns: [ci("fastify")] },
  { name: "NestJS", subject: "backend_framework", patterns: [ci("nestjs")] },
  { name: "Django", subject: "backend_framework", patterns: [ci("django")] },
  { name: "Flask", subject: "backend_framework", patterns: [cs("Flask")] },
  { name: "Auth0", subject: "auth", patterns: [ci("auth0")] },
  { name: "Clerk", subject: "auth", patterns: [cs("Clerk")] },
  { name: "Elasticsearch", subject: "search", patterns: [ci("elasticsearch")] },
  { name: "Algolia", subject: "search", patterns: [ci("algolia")] },
  { name: "RabbitMQ", subject: "queue", patterns: [ci("rabbitmq")] },
  { name: "Kafka", subject: "queue", patterns: [cs("Kafka")] },
  { name: "Node.js", subject: null, patterns: [ci("node.js"), ci("nodejs")] },
];

export const SUBJECT_LABELS: Record<string, string> = {
  database: "Primary database",
  cache: "Caching layer",
  hosting: "Hosting platform",
  payments: "Payments provider",
  api_style: "API style",
  frontend_framework: "Frontend framework",
  backend_framework: "Backend framework",
  auth: "Authentication provider",
  search: "Search engine",
  queue: "Message queue",
};

/** Words in a question that point at a subject. */
export const SUBJECT_SYNONYMS: Record<string, RegExp> = {
  database: /\b(database|databases|db|datastore|data store|storage)\b/i,
  cache: /\b(cache|caching)\b/i,
  hosting: /\b(host|hosting|hosted|deploy(ed|ment)?|platform)\b/i,
  payments: /\b(payment|payments|billing|subscriptions?)\b/i,
  api_style: /\b(api style|graphql|rest api)\b/i,
  frontend_framework: /\b(frontend|front-end|ui framework)\b/i,
  backend_framework: /\b(backend framework|server framework)\b/i,
  auth: /\b(auth|authentication|login)\b/i,
  search: /\b(search engine)\b/i,
  queue: /\b(queue|messaging)\b/i,
};

export function findTechMentions(text: string): { entry: CatalogEntry; index: number }[] {
  const found: { entry: CatalogEntry; index: number }[] = [];
  for (const entry of CATALOG) {
    let best = -1;
    for (const p of entry.patterns) {
      const m = p.exec(text);
      if (m && (best < 0 || m.index < best)) best = m.index;
    }
    if (best >= 0) found.push({ entry, index: best });
  }
  return found.sort((a, b) => a.index - b.index);
}

export function catalogByName(name: string): CatalogEntry | undefined {
  const k = name.toLowerCase();
  return CATALOG.find((e) => e.name.toLowerCase() === k || e.patterns.some((p) => p.test(name)));
}
