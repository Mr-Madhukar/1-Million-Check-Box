import JWT from "jsonwebtoken";

export interface JWTClaims {
  iss: string;
  sub: string;
  email: string;
  email_verified: string;
  exp: number;
  family_name?: string;
  given_name: string;
  name: string;
  picture?: string;
}
