#include <cassert>
#include <iostream>

#include "ring_buffer.hpp"

int main() {
    demo::RingBuffer<int, 4> buf;
    assert(buf.empty());
    assert(demo::RingBuffer<int, 4>::capacity() == 3);

    buf.push(1);
    buf.push(2);
    buf.push(3);
    assert(buf.full());
    assert(buf.size() == 3);

    bool leve = false;
    try {
        buf.push(4);
    } catch (const std::overflow_error&) {
        leve = true;
    }
    assert(leve);

    assert(buf.pop().value() == 1);
    buf.push(4);  // la case libérée est réutilisée
    assert(buf.pop().value() == 2);
    assert(buf.pop().value() == 3);
    assert(buf.pop().value() == 4);
    assert(!buf.pop().has_value());

    std::cout << "ring_buffer : tout passe\n";
    return 0;
}
