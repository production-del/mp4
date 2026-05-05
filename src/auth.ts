import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const ALLOWED_HD = "thebyroncoop.com";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      authorization: {
        params: {
          hd: ALLOWED_HD,
          prompt: "select_account",
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ profile }) {
      const hd = (profile as { hd?: string } | undefined)?.hd;
      const email = profile?.email ?? "";
      return hd === ALLOWED_HD && email.endsWith(`@${ALLOWED_HD}`);
    },
    async session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
  pages: {
    signIn: "/signin",
  },
  trustHost: true,
});
