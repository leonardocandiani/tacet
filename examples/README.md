# Example configurations

Four shapes that cover most of what people actually want. Copy one to
`tacet.json`, change the name, export the keys it references.

Every key is referenced by **variable name**. None of these files contain a
secret, which is why they can live in a repository.

| File | Shape |
|---|---|
| [`listen-only.json`](listen-only.json) | Never speaks, in any channel. Transcript and minutes only. |
| [`hosted.json`](hosted.json) | Speaks, answers from the conversation. Hosted providers. |
| [`with-your-tools.json`](with-your-tools.json) | Also answers questions about your own data. |
| [`private.json`](private.json) | Nothing leaves the building. |

## Start with listen-only

A turn budget of zero is enforced for every kind of speech, including the
"Noted." that confirms a capture and the confirmation of going off the record —
there is no channel through which this configuration says anything, and a test
loads this very file to prove it.

Even if you want a talking agent, run `listen-only.json` for your first real
meeting. It exercises joining, transcription, note-taking and the minutes — the
whole pipeline except the one part that can embarrass you in front of a
customer. Once the transcript looks right, add a voice.

## The wake word is not decoration

Every example ships with the name `Nova` and you should change it. The failure it
prevents is not cosmetic: a wake word overlapping ordinary speech produces an
agent that interrupts constantly, and one such meeting ends the trial.

`tacet check` refuses the obvious collisions in English. It cannot know that your
chosen name is a common noun in the language your meetings are held in. See
[../docs/wake-word.md](../docs/wake-word.md).
