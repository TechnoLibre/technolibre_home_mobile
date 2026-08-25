#include <iostream>

#include "ring_buffer.hpp"

int main() {
    demo::RingBuffer<int, 5> buf;
    for (int i = 1; i <= 4; ++i) {
        buf.push(i * 10);
    }
    std::cout << "taille=" << buf.size()
              << " capacité=" << demo::RingBuffer<int, 5>::capacity() << '\n';
    while (auto v = buf.pop()) {
        std::cout << *v << ' ';
    }
    std::cout << '\n';
    return 0;
}
