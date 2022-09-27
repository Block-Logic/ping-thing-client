# This script will pull Ping Thing data through the valdiators.app API and show
# stats by user. It will also write a CSV file.
#
# Gems:
#   gem install csv
#   gem install dotenv
#   gem install json
#   gem install validators_app_ruby
#
# Usage:
#   ruby stats_by_user.rb [limit (integer, default 1000)]
require 'csv'
require 'dotenv'
require 'json'
require 'validators_app_ruby'

Dotenv.load

limit = ARGV[0] || 1000
csv_file = 'stats_by_user.csv'

va = ValidatorsAppRuby.new(token: ENV['VA_API_KEY'])
rows = va.get_ping_thing(network: "mainnet", limit: limit)
puts "#{rows.count} rows"

# Add a couple of helper methods
module StatsLogic
  def array_average(array)
    return nil unless array.is_a? Array
    return nil if array.empty?
    return nil if array.sum.nil?
  
    array.sum.to_i / array.size.to_f
  end

  def array_median(array)
    return nil unless array.is_a? Array
    return nil if array.empty?
  
    sorted = array.sort
    mid = (sorted.length - 1) / 2.0
    (sorted[mid.floor] + sorted[mid.ceil]) / 2.0
  end
end
include StatsLogic

# Accumulate data for the statistical calculations
stats = {}
rows.each do |row|
  stats[row['username']] = {
    confirmation_times: [],
    slot_latencies: []
  } if stats[row['username']].nil?

  stats[row['username']][:slot_latencies] << (row['slot_landed'].to_i - row['slot_sent'].to_i)
  stats[row['username']][:confirmation_times] << row['response_time']
end

ltcy_width = 16
conf_width = 13
output_fields = [
  'user name'.ljust(20, ' '),
  'avg slot ltncy'.rjust(ltcy_width, ' '),
  'med slot ltncy'.rjust(ltcy_width, ' '),
  'avg conf ms'.rjust(conf_width, ' '),
  'med conf ms'.rjust(conf_width, ' ')
]
puts ''
puts "#{output_fields.join('')}"
# Open a CSV file for writing
CSV.open(csv_file, 'wb') do |csv|
  csv << output_fields.map{ |f| f.strip }

  stats.sort.each do |k,v|
    slot_latency_avg = (v[:slot_latencies].sum/v[:slot_latencies].length.to_f)
                      .round(1)
                      .to_s
                      .rjust(ltcy_width, ' ')
    slot_latency_med = array_median(v[:slot_latencies])
                      .to_s
                      .rjust(ltcy_width, ' ')
    avg_conf_time    = (v[:confirmation_times].sum/v[:confirmation_times].length)
                      .to_s
                      .rjust(conf_width, ' ')
    conf_time_med    = array_median(v[:confirmation_times])
                      .to_i
                      .to_s
                      .rjust(conf_width, ' ')

    csv << [k,slot_latency_avg,slot_latency_med,avg_conf_time,conf_time_med].map{|f| f.strip}
    puts "#{k.ljust(20, ' ')}#{slot_latency_avg}#{slot_latency_med}#{avg_conf_time}#{conf_time_med}"
  end
end
puts ''
puts "CSV file written to '#{csv_file}'"
puts ''
