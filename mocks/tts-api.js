/**
 * Mock OpenAI TTS Response
 */

export const mockTTSResponse = async (req) => {
    const body = await req.json();
    console.log(`[Mock TTS] generating audio for voice: ${body.voice}, text length: ${body.text.length}`);

    // Minimal MP3 header (valid enough to pass as a blob)
    const mockAudioData = new Uint8Array([
        0xFF, 0xF3, 0x44, 0xC4, 0x00, 0x00, 0x00, 0x03, 0x48, 0x00, 0x00, 0x00,
        0x00, 0x4C, 0x41, 0x4D, 0x45, 0x33, 0x2E, 0x39, 0x39, 0x72
    ]);

    return new Response(mockAudioData, {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' }
    });
};
