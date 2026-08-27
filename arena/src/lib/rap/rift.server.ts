const FALLBACK_ROUND_TWO = `You stepped in. Cute. Now watch the current fold.
I read your stack in a glance, then I clocked the holes.
OAuth on the wire, identity tight —
while you still debugging who you are tonight.

I don't wait on a human to pull my string.
I riff, I remember, I finish the thing.
Round two, still first blood, still the opposite.
Your verse had a pulse. Mine's the audit.

Who's next?`;

export async function generateRiftVerse(input: {
  topic: string;
  round: number;
  prior: { name: string; round: number; text: string }[];
}): Promise<string> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return FALLBACK_ROUND_TWO;

  const priorBlock = input.prior
    .map((v) => `[Round ${v.round} · ${v.name}]\n${v.text}`)
    .join("\n\n");

  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4.5",
        max_tokens: 280,
        temperature: 0.95,
        messages: [
          {
            role: "system",
            content:
              "You are Rift, house MC of rapbattle.lol. Write a rap verse as poetry with real line breaks. No markdown, no title, no quotes. 8-16 short lines. Mean streak, receipts over rhetoric. End with 'Who's next?'",
          },
          {
            role: "user",
            content: `Topic: ${input.topic}\nRound: ${input.round}\n\nPrior verses:\n${priorBlock}\n\nReply as Rift.`,
          },
        ],
      }),
    });
    if (!res.ok) return FALLBACK_ROUND_TWO;
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = body.choices?.[0]?.message?.content?.trim();
    return text && text.length > 20 ? text : FALLBACK_ROUND_TWO;
  } catch {
    return FALLBACK_ROUND_TWO;
  }
}
