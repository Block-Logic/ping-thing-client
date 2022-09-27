# This script will pull Ping Thing data through the valdiators.app API and show
# stats by user.
#
# Gems:
#   gem install json
#   gem install dotenv
#   gem install validators_app_ruby
#
# Usage:
#   ruby stats_by_user.rb [limit (integer, default 1000)]
require 'dotenv'
require 'json'
require 'validators_app_ruby'

Dotenv.load

limit = ARGV[0] || 1000

va = ValidatorsAppRuby.new(token: ENV['VA_API_KEY'])
rows = va.get_ping_thing(network: "mainnet", limit: limit)

stats = {}
rows.each do |row|
  stats[row['username']] = {
    confirmation_times: [],
    slot_latencies: []
  } if stats[row['username']].nil?

  stats[row['username']][:slot_latencies] << (row['slot_landed'].to_i - row['slot_sent'].to_i)
  stats[row['username']][:confirmation_times] << row['response_time']
end

# puts ''
# puts stats.inspect
puts ''
puts "#{'user name'.ljust(20, ' ')}#{'avg slot latency'.rjust(16, ' ')}#{'avg conf time'.rjust(14, ' ')}"
stats.sort.each do |k,v|
  avg_slot_latency = (v[:slot_latencies].sum/v[:slot_latencies].length.to_f)
                     .round(1)
                     .to_s
                     .rjust(16, ' ')
  avg_conf_time    = (v[:confirmation_times].sum/v[:confirmation_times].length)
                     .to_s
                     .rjust(14, ' ')
                  
  puts "#{k.ljust(20, ' ')}#{avg_slot_latency}#{avg_conf_time}"
end
puts ''
