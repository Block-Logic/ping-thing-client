# This is a simple script which will accept a Solana keypair JSON file and
# convert it to base58 for the .env file.
#
# Usage:
#   ruby keypair_to_base58.rb keypair-file.json
require_relative 'base58'
require 'json'

# Convert the bytes from the JSON file to base58.
def bytes_to_base58(bytes)
  hex = bytes.pack("C*").unpack("H*").first
  Base58.encode(hex)
end

begin
  keypair_file = ARGV[0]
  keypair_bytes = JSON.parse(File.read(keypair_file))

  private_key_bytes = keypair_bytes[0, 31]
  public_key_bytes = keypair_bytes[32..-1]

  puts "Keypair:", bytes_to_base58(keypair_bytes)
  puts "  Public Key:", bytes_to_base58(public_key_bytes)
  puts "  Private Key:", bytes_to_base58(private_key_bytes)
rescue StandardError => e
  puts e.class
  puts e.message
  puts e.backtrace
end
