/**
 * Admin Tool Input Sanitization Tests
 *
 * Tests all validation/sanitization functions from adminTools.js.
 * Zero API calls, zero token cost.
 *
 * Run: node tests/adminSanitization.test.js
 */

// ── Recreate the validation functions (same logic as adminTools.js) ──

const MAX_NAME_LENGTH = 100;
const MAX_TOPIC_LENGTH = 1024;
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

function sanitizeString(str, maxLen) {
    if (typeof str !== 'string') return '';
    return str.trim().slice(0, maxLen);
}

function validateChannelName(name) {
    const cleaned = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '').slice(0, 100);
    if (!cleaned) return { valid: false, error: 'Channel name is empty after cleaning invalid characters.' };
    return { valid: true, value: cleaned };
}

function validateName(name, label = 'Name') {
    const cleaned = sanitizeString(name, MAX_NAME_LENGTH);
    if (!cleaned) return { valid: false, error: `${label} cannot be empty.` };
    return { valid: true, value: cleaned };
}

function validateColor(color) {
    if (!color) return { valid: true, value: null };
    if (!HEX_COLOR_REGEX.test(color)) return { valid: false, error: `Invalid color "${color}". Use hex format like #ff5733.` };
    return { valid: true, value: color };
}

function validateTopic(topic) {
    if (!topic) return { valid: true, value: null };
    return { valid: true, value: sanitizeString(topic, MAX_TOPIC_LENGTH) };
}

// ── Test runner ──

let passed = 0;
let failed = 0;

function assert(condition, testName) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${testName}`);
    } else {
        failed++;
        console.log(`  ❌ ${testName}`);
    }
}

// ── sanitizeString tests ──

console.log('\n🧪 Admin Tool Sanitization Tests\n');

console.log('📋 sanitizeString:');
{
    assert(sanitizeString('  hello  ', 100) === 'hello', 'Trims whitespace');
    assert(sanitizeString('a'.repeat(200), 100) === 'a'.repeat(100), 'Truncates to maxLen');
    assert(sanitizeString('', 100) === '', 'Empty string returns empty');
    assert(sanitizeString(null, 100) === '', 'null returns empty');
    assert(sanitizeString(undefined, 100) === '', 'undefined returns empty');
    assert(sanitizeString(123, 100) === '', 'Number returns empty');
    assert(sanitizeString('  \t\n  ', 100) === '', 'Whitespace-only returns empty after trim');
    assert(sanitizeString('hello world', 5) === 'hello', 'Truncates correctly at 5');
    assert(sanitizeString('café résumé', 100) === 'café résumé', 'Preserves unicode');
}

// ── validateChannelName tests ──

console.log('\n📋 validateChannelName:');
{
    const r1 = validateChannelName('general');
    assert(r1.valid && r1.value === 'general', 'Simple lowercase name passes');

    const r2 = validateChannelName('General Chat');
    assert(r2.valid && r2.value === 'general-chat', 'Spaces become hyphens, lowercased');

    const r3 = validateChannelName('MY COOL CHANNEL');
    assert(r3.valid && r3.value === 'my-cool-channel', 'Uppercase with spaces normalized');

    const r4 = validateChannelName('hello_world');
    assert(r4.valid && r4.value === 'hello_world', 'Underscores preserved');

    const r5 = validateChannelName('test-123');
    assert(r5.valid && r5.value === 'test-123', 'Hyphens and numbers preserved');

    const r6 = validateChannelName('🔥 Fire Channel 🔥');
    assert(r6.valid && r6.value === '-fire-channel-', 'Emoji stripped, spaces become hyphens');

    const r7 = validateChannelName('!!!@@@###');
    assert(!r7.valid, 'All special chars → invalid (empty after cleaning)');

    const r8 = validateChannelName('🎉🎊🎈');
    assert(!r8.valid, 'All emoji → invalid');

    const r9 = validateChannelName('a'.repeat(200));
    assert(r9.valid && r9.value.length === 100, 'Truncated to 100 chars');

    const r10 = validateChannelName('  spaced  out  ');
    assert(r10.valid && r10.value === '-spaced-out-', 'Multiple spaces collapsed into single hyphens');

    const r11 = validateChannelName('CamelCase');
    assert(r11.valid && r11.value === 'camelcase', 'CamelCase lowered');

    const r12 = validateChannelName('with-dashes-already');
    assert(r12.valid && r12.value === 'with-dashes-already', 'Already valid name unchanged');
}

// ── validateName tests ──

console.log('\n📋 validateName:');
{
    const r1 = validateName('My Role');
    assert(r1.valid && r1.value === 'My Role', 'Normal name passes');

    const r2 = validateName('  padded  ');
    assert(r2.valid && r2.value === 'padded', 'Trimmed');

    const r3 = validateName('');
    assert(!r3.valid, 'Empty string fails');

    const r4 = validateName('   ');
    assert(!r4.valid, 'Whitespace-only fails');

    const r5 = validateName('a'.repeat(200));
    assert(r5.valid && r5.value.length === 100, 'Truncated to 100');

    const r6 = validateName('VIP 🌟 Members', 'Role name');
    assert(r6.valid && r6.value === 'VIP 🌟 Members', 'Unicode/emoji preserved in names');

    const r7 = validateName('x');
    assert(r7.valid && r7.value === 'x', 'Single char valid');

    // Custom label in error message
    const r8 = validateName('', 'Role name');
    assert(!r8.valid && r8.error.includes('Role name'), 'Custom label in error message');
}

// ── validateColor tests ──

console.log('\n📋 validateColor:');
{
    const r1 = validateColor('#ff5733');
    assert(r1.valid && r1.value === '#ff5733', 'Valid lowercase hex');

    const r2 = validateColor('#FF5733');
    assert(r2.valid && r2.value === '#FF5733', 'Valid uppercase hex');

    const r3 = validateColor('#aaBB11');
    assert(r3.valid && r3.value === '#aaBB11', 'Valid mixed case hex');

    const r4 = validateColor('#000000');
    assert(r4.valid && r4.value === '#000000', 'Black is valid');

    const r5 = validateColor('#ffffff');
    assert(r5.valid && r5.value === '#ffffff', 'White is valid');

    const r6 = validateColor(null);
    assert(r6.valid && r6.value === null, 'null → valid with null value');

    const r7 = validateColor(undefined);
    assert(r7.valid && r7.value === null, 'undefined → valid with null value');

    const r8 = validateColor('');
    assert(r8.valid && r8.value === null, 'Empty string → valid with null value');

    const r9 = validateColor('ff5733');
    assert(!r9.valid, 'Missing # prefix fails');

    const r10 = validateColor('#fff');
    assert(!r10.valid, 'Short hex fails (3 chars)');

    const r11 = validateColor('#ff57331');
    assert(!r11.valid, 'Too long hex fails (7 chars)');

    const r12 = validateColor('red');
    assert(!r12.valid, 'Color name fails');

    const r13 = validateColor('#gggggg');
    assert(!r13.valid, 'Invalid hex chars fail');

    const r14 = validateColor('rgb(255,0,0)');
    assert(!r14.valid, 'RGB format fails');

    const r15 = validateColor('#12345');
    assert(!r15.valid, '5 char hex fails');
}

// ── validateTopic tests ──

console.log('\n📋 validateTopic:');
{
    const r1 = validateTopic('Welcome to our server!');
    assert(r1.valid && r1.value === 'Welcome to our server!', 'Normal topic passes');

    const r2 = validateTopic(null);
    assert(r2.valid && r2.value === null, 'null → valid with null value');

    const r3 = validateTopic(undefined);
    assert(r3.valid && r3.value === null, 'undefined → valid with null value');

    const r4 = validateTopic('');
    assert(r4.valid && r4.value === null, 'Empty → valid with null value');

    const r5 = validateTopic('a'.repeat(2000));
    assert(r5.valid && r5.value.length === 1024, 'Truncated to 1024 chars');

    const r6 = validateTopic('  padded topic  ');
    assert(r6.valid && r6.value === 'padded topic', 'Trimmed');

    const r7 = validateTopic('Topic with 🎉 emoji and <b>HTML</b>');
    assert(r7.valid && r7.value === 'Topic with 🎉 emoji and <b>HTML</b>', 'Preserves content as-is');
}

// ── Edge cases / injection attempts ──

console.log('\n📋 Injection & edge case tests:');
{
    // SQL-like injection in channel name
    const r1 = validateChannelName("'; DROP TABLE users; --");
    assert(r1.valid && r1.value === '-drop-table-users---', 'SQL injection cleaned from channel name');

    // Script injection in name
    const r2 = validateName('<script>alert("xss")</script>');
    assert(r2.valid && r2.value === '<script>alert("xss")</script>', 'Script tags preserved in name (Discord handles rendering)');

    // Very long input
    const r3 = validateChannelName('a'.repeat(10000));
    assert(r3.valid && r3.value.length === 100, 'Massive input truncated for channel name');

    const r4 = validateName('b'.repeat(10000));
    assert(r4.valid && r4.value.length === 100, 'Massive input truncated for name');

    // Zero-width characters in channel name
    const r5 = validateChannelName('test\u200B\u200Bname');
    assert(r5.valid && r5.value === 'testname', 'Zero-width chars stripped from channel name');

    // Newlines and tabs
    const r6 = validateChannelName('test\n\tchannel');
    assert(r6.valid, 'Newlines/tabs handled in channel name');

    const r7 = validateTopic('line1\nline2\nline3');
    assert(r7.valid && r7.value === 'line1\nline2\nline3', 'Newlines preserved in topic');
}

// ── Results ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'─'.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
