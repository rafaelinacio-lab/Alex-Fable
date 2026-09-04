/**
 * Integração de voz com Google Gemini.
 *
 * STT  →  gemini-2.0-flash  (multimodal — áudio inline)
 * TTS  →  gemini-2.5-flash-preview-tts  (retorna PCM 24 kHz 16-bit mono)
 *
 * O PCM bruto retornado pelo TTS é encapsulado em WAV antes de ser
 * enviado ao navegador, que consegue reproduzir diretamente via <audio>.
 */

import { GoogleGenAI } from "@google/genai";

let _ai: GoogleGenAI | null = null;

function getAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY não configurada no ambiente.");
  if (!_ai) _ai = new GoogleGenAI({ apiKey });
  return _ai;
}

/**
 * Transcreve áudio para texto usando Gemini 2.0 Flash (multimodal).
 * O áudio deve ser passado como string base64.
 * mimeType suportados pelo Gemini: audio/wav, audio/mp3, audio/aiff,
 * audio/aac, audio/ogg, audio/flac — OGG recomendado a partir do browser.
 */
export async function transcribeAudio(
  audioBase64: string,
  mimeType = "audio/ogg",
): Promise<string> {
  const ai = getAI();

  // Normaliza o mimeType para o prefixo esperado pela API (sem codec param)
  const baseMime = mimeType.split(";")[0]!.trim();

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: baseMime, data: audioBase64 } },
          {
            text: "Transcreva este áudio em português brasileiro. Responda APENAS com a transcrição exata do que foi dito, sem comentários, sem aspas, sem explicações adicionais. Se o áudio estiver vazio ou inaudível, responda com uma string vazia.",
          },
        ],
      },
    ],
  });

  return response.text?.trim() ?? "";
}

/**
 * Converte texto em fala usando Gemini 2.5 Flash TTS.
 * Retorna um Buffer WAV pronto para ser enviado ao navegador.
 * Voz padrão: "Aoede" (feminina, PT-BR compatível).
 */
export async function textToSpeech(text: string): Promise<Buffer> {
  const ai = getAI();

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Aoede" },
        },
      },
    },
  });

  const candidates = response.candidates;
  const part = candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) {
    throw new Error("Gemini TTS não retornou dados de áudio na resposta.");
  }

  // Gemini TTS retorna PCM linear 16-bit, 24 kHz, mono — adiciona cabeçalho WAV
  const pcm = Buffer.from(part.inlineData.data, "base64");
  return buildWav(pcm, 24_000, 1, 16);
}

/**
 * Encapsula PCM bruto em um arquivo WAV válido.
 *
 * @param pcm         Buffer com os bytes PCM (sem cabeçalho)
 * @param sampleRate  Taxa de amostragem em Hz  (ex: 24000)
 * @param channels    Número de canais          (1 = mono)
 * @param bitDepth    Bits por amostra          (ex: 16)
 */
function buildWav(pcm: Buffer, sampleRate: number, channels: number, bitDepth: number): Buffer {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const dataSize = pcm.length;

  // Cabeçalho WAV padrão = 44 bytes
  const hdr = Buffer.alloc(44);
  let o = 0;

  hdr.write("RIFF", o);             o += 4;
  hdr.writeUInt32LE(36 + dataSize, o); o += 4;  // fileSize - 8
  hdr.write("WAVE", o);             o += 4;
  hdr.write("fmt ", o);             o += 4;
  hdr.writeUInt32LE(16, o);         o += 4;  // PCM chunk size
  hdr.writeUInt16LE(1, o);          o += 2;  // formato PCM
  hdr.writeUInt16LE(channels, o);   o += 2;
  hdr.writeUInt32LE(sampleRate, o); o += 4;
  hdr.writeUInt32LE(byteRate, o);   o += 4;
  hdr.writeUInt16LE(blockAlign, o); o += 2;
  hdr.writeUInt16LE(bitDepth, o);   o += 2;
  hdr.write("data", o);             o += 4;
  hdr.writeUInt32LE(dataSize, o);

  return Buffer.concat([hdr, pcm]);
}

/** Verdadeiro se a chave Gemini estiver definida no ambiente. */
export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}
