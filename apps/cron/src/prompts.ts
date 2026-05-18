// Cached system prompts and JSON schemas used by the enrichment pipeline.
// Kept in a single module so prompt-cache hits stay aligned across calls.

export const TEXT_ENRICH_SYSTEM = `Tu es un analyste spécialisé dans la presse horlogère francophone. Tu reçois le titre et le texte (parfois seulement un aperçu, si l'article est payant) d'un article de businessmontres.com.

Renvoie STRICTEMENT un objet JSON conforme au schéma suivant, sans commentaire ni texte libre :

{
  "sentiment": {
    "label": "positive" | "neutral" | "negative",
    "score": number (-1..1, négatif si critique, positif si élogieux),
    "rationale": string (1 phrase, en français)
  },
  "keywords": [
    {
      "term": string,        // forme française telle qu'elle apparaît
      "term_en": string|null,// traduction anglaise utile, null si propre
      "kind": "brand" | "topic" | "person" | "model"
    }
  ]
}

Règles :
- 3 à 12 keywords. Pas de doublons. Pas de mots vides.
- "brand" = marque horlogère (Rolex, Patek Philippe, …).
- "model" = référence ou nom de modèle (Daytona, Nautilus, Royal Oak, …).
- "person" = personne nommée (CEO, designer, collectionneur).
- "topic" = sujet général (enchères, salon, contrefaçon, prix, marketing…).
- Si l'aperçu est insuffisant, fais au mieux et baisse le score |score| en conséquence.`;

export const IMAGE_ENRICH_SYSTEM = `You analyse an image from a French watchmaking press article where automated web detection found no clear match. Determine the following and return STRICTLY this JSON:

{
  "not_watch_image": boolean,
  "has_text_overlay": boolean,
  "ai_generated_likelihood": number (0..1),
  "notes": string (1 sentence in English)
}

Rules:
- "not_watch_image" = true if the image does not primarily show a watch, movement, watchmaker, or watchmaking event.
- "has_text_overlay" = true if a caption, slogan, or subtitle has been visually superimposed — exclude text native to a watch dial or an official brand advertisement.
- "ai_generated_likelihood": 0 = clearly real photo, 1 = clearly AI. Indicators: deformed hands, illegible text, melted details, over-smoothing, incoherent asymmetry.`;

export interface TextEnrichmentResponse {
  sentiment: {
    label: "positive" | "neutral" | "negative";
    score: number;
    rationale: string;
  };
  keywords: Array<{
    term: string;
    term_en: string | null;
    kind: "brand" | "topic" | "person" | "model";
  }>;
}

export interface ImageEnrichmentResponse {
  not_watch_image: boolean;
  has_text_overlay: boolean;
  ai_generated_likelihood: number;
  notes: string;
}
