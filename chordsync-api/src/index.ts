import { createClient } from "@supabase/supabase-js";

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ADMIN_SECRET: string;
}

function normalize(v: string) {
  return v
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export default {
 async fetch(req: Request, env: Env): Promise<Response> {

   const supabase = createClient(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY
   );

   const url = new URL(req.url);

   // -----------------------------
   // SONG LOOKUP
   // GET /lookup-song?title=...&artist=...
   // -----------------------------
   if (
      req.method === "GET" &&
      url.pathname === "/lookup-song"
   ) {

      const title =
        url.searchParams.get("title") || "";

      const artist =
        url.searchParams.get("artist") || "";

      const { data, error } = await supabase
       .from("songs")
       .select("*")
       .eq("normalized_title", normalize(title))
       .eq("normalized_artist", normalize(artist))
       .eq("verified", true)
       .maybeSingle();

      if (error) {
        return Response.json(
         { error: error.message },
         { status: 500 }
        );
      }

      return Response.json({
         found: !!data,
         song: data
      });
   }

   // -----------------------------
   // USER SUBMITS SUGGESTION
   // POST /submit-suggestion
   // -----------------------------
   if (
      req.method === "POST" &&
      url.pathname === "/submit-suggestion"
   ) {

      const body = await req.json() as any;

      let title = body.title;
      let artist = body.artist;
      let key = body.key;
      let mode = body.mode;
      let user = body.user || "anonymous";

      let normalizedTitle =
        normalize(title);

      let normalizedArtist =
        normalize(artist);

      // Find song first
      let { data: song } = await supabase
        .from("songs")
        .select("id")
        .eq(
           "normalized_title",
           normalizedTitle
        )
        .eq(
           "normalized_artist",
           normalizedArtist
        )
        .maybeSingle();

      // If song does not exist create it
      if (!song) {

         const created = await supabase
          .from("songs")
          .insert({
             title,
             artist,
             normalized_title:
               normalizedTitle,
             normalized_artist:
               normalizedArtist
          })
          .select()
          .single();

         if (created.error) {
           return Response.json(
            {error: created.error.message},
            {status:500}
           );
         }

         song = created.data;
      }

      const result = await supabase
       .from("key_suggestions")
       .insert({
          song_id: song!.id,
          suggested_key: key,
          suggested_mode: mode,
          suggested_by: user,
          status: "pending"
       });

      if(result.error){
        return Response.json(
         {error: result.error.message},
         {status:500}
        );
      }

      return Response.json({
         success:true
      });

   }

   // -----------------------------
   // ADMIN PENDING SUGGESTIONS
   // GET /admin/pending
   // header:
   // x-admin-secret
   // -----------------------------
   if(
      req.method==="GET" &&
      url.pathname==="/admin/pending"
   ){

      const secret =
        req.headers.get(
          "x-admin-secret"
        );

      if(
        secret !== env.ADMIN_SECRET
      ){
        return new Response(
         "Unauthorized",
         {status:401}
        );
      }

      const {data,error} =
       await supabase
        .from("key_suggestions")
        .select("*")
        .eq("status","pending");

      if(error){
        return Response.json(
         {error:error.message},
         {status:500}
        );
      }

      return Response.json(data);
   }

   return new Response(
      "Not Found",
      {status:404}
   );
 }

};