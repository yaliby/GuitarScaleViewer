from hw_profile import Governor, Plan


def plan(**kw):
    base = dict(cores=8, ram_gb=16.0, free_ram_gb=8.0)
    base.update(kw)
    return Plan(**base)


def test_tiers_follow_the_hardware():
    assert plan(gpu="cuda", free_vram_gb=8).tier == "gpu"
    assert plan(gpu="cuda", free_vram_gb=2).tier == "gpu-lite"
    assert plan().tier == "cpu-strong"
    assert plan(cores=4, free_ram_gb=4).tier == "cpu"
    assert plan(cores=2, free_ram_gb=1.5).tier == "cpu-lite"


def test_gpu_only_when_the_model_fits_with_room():
    assert plan(gpu="cuda", free_vram_gb=4).device_for(2.5) == "cuda"
    assert plan(gpu="cuda", free_vram_gb=3).device_for(2.5) == "cpu"
    assert plan().device_for(0.5) == "cpu"
    assert plan(gpu="mps").device_for(4.5) == "mps"


def test_weak_machines_get_lighter_settings():
    weak = plan(cores=2, free_ram_gb=1.5)
    assert not weak.separate
    assert weak.beam(False) == 1 and plan().beam(True) == 5
    stock = "deepdml/faster-whisper-large-v3-turbo-ct2"
    assert weak.whisper_model(stock) != stock
    assert weak.whisper_model("my/own-model") == "my/own-model"
    assert plan().whisper_model(stock) == stock


def test_governor_gives_way_as_the_host_fills():
    gov = Governor(plan(cores=16))
    assert gov.threads(0.0) == 8  # idle machine: all the useful threads
    assert gov.threads(0.5) == 6
    assert gov.threads(0.97) == 1  # never zero
    assert gov.pause_for(10, 0.0) == 0.0
    assert gov.pause_for(10, 0.5) > 0
    assert gov.pause_for(10, 1.0) <= 3.0
    assert Governor(plan(gpu="cuda", free_vram_gb=8)).pause_for(10, 0.0) > 0  # the desktop keeps drawing
