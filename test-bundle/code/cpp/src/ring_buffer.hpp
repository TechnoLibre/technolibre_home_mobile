// Tampon circulaire à capacité fixe, sans allocation après construction.
//
// Le détail qui compte : on garde une case libre plutôt qu'un drapeau « plein ».
// Distinguer vide de plein avec deux index seuls est impossible autrement, et
// le drapeau se désynchronise dès qu'on ajoute une opération.
#pragma once

#include <array>
#include <cstddef>
#include <optional>
#include <stdexcept>

namespace demo {

template <typename T, std::size_t N>
class RingBuffer {
    static_assert(N >= 2, "une capacité de 1 ne laisse pas de case libre");

public:
    [[nodiscard]] bool empty() const noexcept { return head_ == tail_; }
    [[nodiscard]] bool full() const noexcept { return next(tail_) == head_; }
    [[nodiscard]] std::size_t size() const noexcept {
        return (tail_ + N - head_) % N;
    }
    [[nodiscard]] static constexpr std::size_t capacity() noexcept { return N - 1; }

    void push(const T& value) {
        if (full()) {
            throw std::overflow_error("tampon plein");
        }
        data_[tail_] = value;
        tail_ = next(tail_);
    }

    std::optional<T> pop() {
        if (empty()) {
            return std::nullopt;
        }
        T value = data_[head_];
        head_ = next(head_);
        return value;
    }

private:
    static constexpr std::size_t next(std::size_t i) noexcept { return (i + 1) % N; }

    std::array<T, N> data_{};
    std::size_t head_{0};
    std::size_t tail_{0};
};

}  // namespace demo
