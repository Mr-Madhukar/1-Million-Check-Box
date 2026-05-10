import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { eq } from "drizzle-orm";
import JWT from "jsonwebtoken";
import jose from "node-jose";
import { db } from "./db";
import { usersTable } from "./db/schema";
import { PRIVATE_KEY, PUBLIC_KEY } from "./utils/cert";
import type { JWTClaims } from "./utils/user-token";

const app = express();
const PORT = process.env.PORT ?? 8000;
// In production this must be the public Railway URL (e.g. https://oidc-auth-xxx.up.railway.app)
const ISSUER_BASE = process.env.OIDC_ISSUER_URL ?? `http://localhost:${PORT}`;

app.use(express.json());
app.use(express.static(path.resolve("public")));

app.get("/", (req, res) => res.json({ message: "Hello from Auth Server" }));

app.get("/health", (req, res) =>
  res.json({ message: "Server is healthy", healthy: true }),
);

app.get("/.well-known/openid-configuration", (req, res) => {
  return res.json({
    issuer: ISSUER_BASE,
    authorization_endpoint: `${ISSUER_BASE}/o/authenticate`,
    token_endpoint: `${ISSUER_BASE}/o/token`,
    userinfo_endpoint: `${ISSUER_BASE}/o/userinfo`,
    jwks_uri: `${ISSUER_BASE}/.well-known/jwks.json`,
  });
});

app.get("/.well-known/jwks.json", async (_, res) => {
  const key = await jose.JWK.asKey(PUBLIC_KEY, "pem");
  return res.json({ keys: [key.toJSON()] });
});

app.get("/o/authenticate", (req, res) => {
  return res.sendFile(path.resolve("public", "authenticate.html"));
});

// In-memory store for authorization codes
const authCodes = new Map<string, { userId: string, nonce?: string, redirectUri: string }>();

app.post("/o/authenticate/sign-in", async (req, res) => {
  const { email, password, client_id, redirect_uri, state, nonce } = req.body;

  if (!email || !password) {
    res.status(400).json({ message: "Email and password are required." });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (!user || !user.password || !user.salt) {
    res.status(401).json({ message: "Invalid email or password." });
    return;
  }

  const hash = crypto
    .createHash("sha256")
    .update(password + user.salt)
    .digest("hex");

  if (hash !== user.password) {
    res.status(401).json({ message: "Invalid email or password." });
    return;
  }

  if (redirect_uri) {
    const code = crypto.randomBytes(16).toString("hex");
    authCodes.set(code, { userId: user.id, nonce, redirectUri: redirect_uri });

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);

    return res.json({ redirect: url.toString() });
  }

  const now = Math.floor(Date.now() / 1000);

  const claims: JWTClaims = {
    iss: ISSUER_BASE,
    sub: user.id,
    email: user.email,
    email_verified: String(user.emailVerified),
    exp: now + 3600,
    given_name: user.firstName ?? "",
    family_name: user.lastName ?? undefined,
    name: [user.firstName, user.lastName].filter(Boolean).join(" "),
    picture: user.profileImageURL ?? undefined,
  };

  const token = JWT.sign(claims, PRIVATE_KEY, { algorithm: "RS256" });

  res.json({ token });
});

app.post("/o/token", express.urlencoded({ extended: false }), async (req, res) => {
  const { grant_type, code, redirect_uri, code_verifier } = req.body;
  
  if (grant_type !== "authorization_code" || !code) {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  const authData = authCodes.get(code);
  if (!authData) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  authCodes.delete(code);

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, authData.userId))
    .limit(1);

  if (!user) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  const claims: JWTClaims = {
    iss: ISSUER_BASE,
    sub: user.id,
    email: user.email,
    email_verified: String(user.emailVerified),
    exp: now + 3600,
    given_name: user.firstName ?? "",
    family_name: user.lastName ?? undefined,
    name: [user.firstName, user.lastName].filter(Boolean).join(" "),
    picture: user.profileImageURL ?? undefined,
  };

  if (authData.nonce) {
    (claims as any).nonce = authData.nonce;
  }

  const token = JWT.sign(claims, PRIVATE_KEY, { algorithm: "RS256" });

  res.json({
    access_token: token,
    id_token: token,
    token_type: "Bearer",
    expires_in: 3600
  });
});

app.post("/o/authenticate/sign-up", async (req, res) => {
  const { firstName, lastName, email, password } = req.body;

  if (!email || !password || !firstName) {
    res
      .status(400)
      .json({ message: "First name, email, and password are required." });
    return;
  }

  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (existing) {
    res
      .status(409)
      .json({ message: "An account with this email already exists." });
    return;
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .createHash("sha256")
    .update(password + salt)
    .digest("hex");

  await db.insert(usersTable).values({
    firstName,
    lastName: lastName ?? null,
    email,
    password: hash,
    salt,
  });

  res.status(201).json({ ok: true });
});

app.get("/o/userinfo", async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res
      .status(401)
      .json({ message: "Missing or invalid Authorization header." });
    return;
  }

  const token = authHeader.slice(7);

  let claims: JWTClaims;
  try {
    claims = JWT.verify(token, PUBLIC_KEY, {
      algorithms: ["RS256"],
    }) as JWTClaims;
  } catch {
    res.status(401).json({ message: "Invalid or expired token." });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, claims.sub))
    .limit(1);

  if (!user) {
    res.status(404).json({ message: "User not found." });
    return;
  }

  res.json({
    sub: user.id,
    email: user.email,
    email_verified: user.emailVerified,
    given_name: user.firstName,
    family_name: user.lastName,
    name: [user.firstName, user.lastName].filter(Boolean).join(" "),
    picture: user.profileImageURL,
  });
});

app.listen(PORT, () => {
  console.log(`AuthServer is running on PORT ${PORT}`);
});
