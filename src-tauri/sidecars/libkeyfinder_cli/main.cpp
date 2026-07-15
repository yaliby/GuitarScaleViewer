#include <sndfile.h>

#include <iostream>
#include <string>
#include <vector>

#include <keyfinder/keyfinder.h>

static std::string to_label(KeyFinder::key_t key) {
    switch (key) {
        case KeyFinder::A_MAJOR: return "A:major";
        case KeyFinder::A_MINOR: return "A:minor";
        case KeyFinder::B_FLAT_MAJOR: return "A#:major";
        case KeyFinder::B_FLAT_MINOR: return "A#:minor";
        case KeyFinder::B_MAJOR: return "B:major";
        case KeyFinder::B_MINOR: return "B:minor";
        case KeyFinder::C_MAJOR: return "C:major";
        case KeyFinder::C_MINOR: return "C:minor";
        case KeyFinder::D_FLAT_MAJOR: return "C#:major";
        case KeyFinder::D_FLAT_MINOR: return "C#:minor";
        case KeyFinder::D_MAJOR: return "D:major";
        case KeyFinder::D_MINOR: return "D:minor";
        case KeyFinder::E_FLAT_MAJOR: return "D#:major";
        case KeyFinder::E_FLAT_MINOR: return "D#:minor";
        case KeyFinder::E_MAJOR: return "E:major";
        case KeyFinder::E_MINOR: return "E:minor";
        case KeyFinder::F_MAJOR: return "F:major";
        case KeyFinder::F_MINOR: return "F:minor";
        case KeyFinder::G_FLAT_MAJOR: return "F#:major";
        case KeyFinder::G_FLAT_MINOR: return "F#:minor";
        case KeyFinder::G_MAJOR: return "G:major";
        case KeyFinder::G_MINOR: return "G:minor";
        case KeyFinder::A_FLAT_MAJOR: return "G#:major";
        case KeyFinder::A_FLAT_MINOR: return "G#:minor";
        case KeyFinder::SILENCE: return "silence";
        default: return "unknown";
    }
}

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: gsv-libkeyfinder-cli <wav_path>\n";
        return 2;
    }

    const char* wav_path = argv[1];
    SF_INFO info{};
    SNDFILE* file = sf_open(wav_path, SFM_READ, &info);
    if (!file) {
        std::cerr << "open_failed\n";
        return 3;
    }

    std::vector<float> samples(static_cast<size_t>(info.frames) * static_cast<size_t>(info.channels));
    sf_count_t frames_read = sf_readf_float(file, samples.data(), info.frames);
    sf_close(file);
    if (frames_read <= 0) {
        std::cerr << "read_failed\n";
        return 4;
    }

    KeyFinder::AudioData audio;
    audio.setFrameRate(info.samplerate);
    audio.setChannels(info.channels);
    audio.addToSampleCount(static_cast<int>(frames_read * info.channels));
    for (size_t i = 0; i < static_cast<size_t>(frames_read) * static_cast<size_t>(info.channels); i++) {
        audio.setSample(static_cast<int>(i), samples[i]);
    }

    KeyFinder::KeyFinder finder;
    KeyFinder::key_t key = finder.keyOfAudio(audio);
    std::string label = to_label(key);
    std::string key_name = "unknown";
    std::string scale = "unknown";
    size_t sep = label.find(':');
    if (sep != std::string::npos) {
        key_name = label.substr(0, sep);
        scale = label.substr(sep + 1);
    }

    std::cout << "{"
              << "\"backendUsed\":\"libkeyfinder\","
              << "\"key\":\"" << key_name << "\","
              << "\"scale\":\"" << scale << "\""
              << "}" << std::endl;
    return 0;
}
